using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace ComputerUse.WindowsHost;

/// <summary>
/// 运行时调用的辅助模式：截图文字识别、一次粘贴的剪贴板会话、用户最近一次输入距今的时间。
/// 它们不打开窗口、不取单实例互斥体，完成后直接退出。协议与 macOS 宿主相同。
/// </summary>
internal static class NativeHelpers
{
    internal const string RecognizeArgument = "--recognize-text";
    internal const string PasteArgument = "--paste-session";
    internal const string IdleArgument = "--input-idle";
    private const int ImageLimit = 64 * 1024 * 1024;
    private const int TextLimit = 1024 * 1024;
    private const int DelayLimitMs = 5_000;

    // MARK: 文字识别

    /// <summary>从标准输入读一张 PNG 或 JPEG，输出 {"lines":[{"text","x","y","width","height"}]}，坐标是图片像素。</summary>
    internal static int RecognizeText()
    {
        try
        {
            var data = ReadAll(Console.OpenStandardInput(), ImageLimit);
            if (data is null) return 1;
            // 空输入是 macOS 的预热请求；Windows 的系统识别器不需要预热。
            var lines = data.Length == 0 ? new List<RecognizedLine>() : Task.Run(() => RecognizeAsync(data)).GetAwaiter().GetResult();
            if (lines is null) return 1;
            WriteJson(new { lines });
            return 0;
        }
        catch { return 1; }
    }

    internal sealed record RecognizedLine(string Text, double X, double Y, double Width, double Height)
    {
        /// <summary>两行在竖直方向重叠至少较矮一行的一半，且水平方向相交：视为截图上的同一处文字。</summary>
        internal bool Overlaps(RecognizedLine other)
        {
            double top = Math.Max(Y, other.Y), bottom = Math.Min(Y + Height, other.Y + other.Height);
            double left = Math.Max(X, other.X), right = Math.Min(X + Width, other.X + other.Width);
            return right > left && bottom > top && bottom - top >= 0.5 * Math.Min(Height, other.Height);
        }

        internal bool HasNativeLetters => Text.Any(value => value > '\u007F' && char.IsLetter(value));
    }

    /// <summary>
    /// 合并两遍识别。英文识别器认代码、路径和命令更准，但认不出中文等文字；用户语言的识别器正相反。
    /// 同一处文字只要用户语言那一遍认出了非 ASCII 字母，就用那一遍的结果，其余位置用英文那一遍。
    /// </summary>
    internal static List<RecognizedLine> Merge(IReadOnlyList<RecognizedLine> primary, IReadOnlyList<RecognizedLine> secondary)
    {
        var used = new HashSet<int>();
        var result = new List<RecognizedLine>();
        foreach (var line in primary)
        {
            var overlapping = Enumerable.Range(0, secondary.Count).Where(index => line.Overlaps(secondary[index])).ToArray();
            if (overlapping.Any(index => secondary[index].HasNativeLetters))
                result.AddRange(overlapping.Where(used.Add).Select(index => secondary[index]));
            else result.Add(line);
        }
        result.AddRange(Enumerable.Range(0, secondary.Count).Where(index => secondary[index].HasNativeLetters && !used.Contains(index))
            .Select(index => secondary[index]));
        return Ordered(result);
    }

    /// <summary>按阅读顺序排列：竖直中心落在本行第一段高度范围内的算同一行，行内从左到右。</summary>
    internal static List<RecognizedLine> Ordered(IEnumerable<RecognizedLine> lines)
    {
        var rows = new List<List<RecognizedLine>>();
        foreach (var line in lines.OrderBy(line => line.Y).ThenBy(line => line.X))
        {
            var anchor = rows.Count > 0 ? rows[^1][0] : null;
            if (anchor is not null && line.Y + line.Height / 2 < anchor.Y + anchor.Height) rows[^1].Add(line);
            else rows.Add([line]);
        }
        return rows.SelectMany(row => row.OrderBy(line => line.X)).ToList();
    }

    private static List<RecognizedLine> Lines(OcrResult result, double scale)
    {
        var lines = new List<RecognizedLine>();
        foreach (var line in result.Lines)
        {
            if (line.Words.Count == 0) continue;
            double left = double.MaxValue, top = double.MaxValue, right = double.MinValue, bottom = double.MinValue;
            foreach (var word in line.Words)
            {
                left = Math.Min(left, word.BoundingRect.X);
                top = Math.Min(top, word.BoundingRect.Y);
                right = Math.Max(right, word.BoundingRect.X + word.BoundingRect.Width);
                bottom = Math.Max(bottom, word.BoundingRect.Y + word.BoundingRect.Height);
            }
            var text = JoinWords(line.Words.Select(word => word.Text));
            if (text.Length > 0) lines.Add(new RecognizedLine(text, left / scale, top / scale, (right - left) / scale, (bottom - top) / scale));
        }
        return lines;
    }

    private static async Task<List<RecognizedLine>?> RecognizeAsync(byte[] data)
    {
        // 第一遍用英文识别器（装有时），第二遍用用户语言的识别器；只有一种可用时识别一遍。
        var profile = OcrEngine.TryCreateFromUserProfileLanguages();
        var englishLanguage = OcrEngine.AvailableRecognizerLanguages
            .FirstOrDefault(language => language.LanguageTag.StartsWith("en", StringComparison.OrdinalIgnoreCase));
        var english = englishLanguage is null ? null : OcrEngine.TryCreateFromLanguage(englishLanguage);
        var primary = english ?? profile;
        if (primary is null) return null;
        var secondary = english is not null && profile is not null
            && !profile.RecognizerLanguage.LanguageTag.StartsWith("en", StringComparison.OrdinalIgnoreCase) ? profile : null;
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream))
        {
            writer.WriteBytes(data);
            await writer.StoreAsync();
            writer.DetachStream();
        }
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream);
        // 识别器有最大边长；超出时等比缩小，结果坐标再换算回原图像素。
        var longest = Math.Max(decoder.PixelWidth, decoder.PixelHeight);
        var scale = longest > OcrEngine.MaxImageDimension ? (double)OcrEngine.MaxImageDimension / longest : 1.0;
        var transform = new BitmapTransform
        {
            ScaledWidth = (uint)Math.Max(1, Math.Floor(decoder.PixelWidth * scale)),
            ScaledHeight = (uint)Math.Max(1, Math.Floor(decoder.PixelHeight * scale)),
            InterpolationMode = BitmapInterpolationMode.Fant,
        };
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied, transform,
            ExifOrientationMode.IgnoreExifOrientation, ColorManagementMode.DoNotColorManage);
        var lines = Ordered(Lines(await primary.RecognizeAsync(bitmap), scale));
        return secondary is null ? lines : Merge(lines, Lines(await secondary.RecognizeAsync(bitmap), scale));
    }

    /// <summary>识别器把中日韩文字逐字当成单词并用空格连接；相邻两个单词都是这类文字时不加空格。</summary>
    internal static string JoinWords(IEnumerable<string> words)
    {
        var text = new StringBuilder();
        foreach (var word in words.Where(value => value.Length > 0))
        {
            if (text.Length > 0 && !(IsCjk(text[^1]) && IsCjk(word[0]))) text.Append(' ');
            text.Append(word);
        }
        return text.ToString();
    }

    private static bool IsCjk(char value) =>
        value is >= '\u3000' and <= '\u30FF' or >= '\u3400' and <= '\u4DBF' or >= '\u4E00' and <= '\u9FFF'
            or >= '\uAC00' and <= '\uD7AF' or >= '\uF900' and <= '\uFAFF' or >= '\uFF00' and <= '\uFFEF';

    // MARK: 用户输入

    /// <summary>输出 {"idleMs":N}：距离本会话最近一次键盘或鼠标输入的毫秒数。</summary>
    internal static int InputIdle()
    {
        var info = new LastInputInfo { Size = (uint)Marshal.SizeOf<LastInputInfo>() };
        if (!GetLastInputInfo(ref info)) return 1;
        // 两者都是开机后的毫秒数（49.7 天回绕），按无符号差计算。
        var idle = unchecked((uint)Environment.TickCount - info.Time);
        WriteJson(new { idleMs = idle });
        return 0;
    }

    // MARK: 剪贴板会话

    /// <summary>
    /// 一次粘贴的剪贴板会话。{"op":"stage","text","restore"} 保存剪贴板（restore 为 false 时不读取）并写入文字；
    /// {"op":"finish","delayMs"} 等目标应用读完后，只在剪贴板仍是我们写入的内容时换回原内容。
    /// 输入提前结束时立即换回。保存的内容只留在本进程，不会输出。
    /// </summary>
    internal static int PasteSession()
    {
        var session = new ClipboardSession(new SystemClipboard());
        try
        {
            using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
            using var output = Console.OpenStandardOutput();
            while (input.ReadLine() is { } line)
            {
                if (line.Length > 8 * TextLimit) return 1;
                var reply = session.Handle(line);
                if (reply is null) return 1;
                var bytes = Encoding.UTF8.GetBytes(reply + "\n");
                output.Write(bytes);
                output.Flush();
            }
            return 0;
        }
        catch { return 1; }
        finally { session.EndOfInput(); }
    }

    internal sealed record ClipboardEntry(uint Format, byte[] Data, bool Metafile);

    internal interface IClipboardStore
    {
        uint Sequence { get; }
        /// <summary>保存全部格式；剪贴板被别的程序占用时为 null。complete 为 false 表示有的格式没有保存下来。</summary>
        (List<ClipboardEntry> Entries, bool Complete)? Read();
        /// <summary>清空剪贴板并写入文字（排除剪贴板历史和云同步）。返回写入后的序号，失败时为 null。</summary>
        uint? Write(string text);
        bool Restore(IReadOnlyList<ClipboardEntry> entries);
    }

    internal sealed class ClipboardSession(IClipboardStore store, Action<int>? sleep = null)
    {
        private readonly Action<int> _sleep = sleep ?? Thread.Sleep;
        private List<ClipboardEntry>? _saved;
        private uint? _written;
        private bool _staged;
        internal bool Finished { get; private set; }

        internal string? Handle(string line)
        {
            JsonElement request;
            try { request = JsonDocument.Parse(line).RootElement; }
            catch (JsonException) { return null; }
            if (request.ValueKind != JsonValueKind.Object || !request.TryGetProperty("op", out var op) || op.ValueKind != JsonValueKind.String)
                return null;
            switch (op.GetString())
            {
                case "stage":
                    if (_staged || Finished || !request.TryGetProperty("text", out var value) || value.ValueKind != JsonValueKind.String) return null;
                    var text = value.GetString() ?? "";
                    if (text.Length == 0 || Encoding.UTF8.GetByteCount(text) > TextLimit) return null;
                    var restore = !request.TryGetProperty("restore", out var flag) || flag.ValueKind != JsonValueKind.False;
                    _staged = true;
                    return Stage(text, restore);
                case "finish":
                    if (!_staged || Finished) return null;
                    var delay = request.TryGetProperty("delayMs", out var number) && number.TryGetInt32(out var milliseconds) ? milliseconds : 0;
                    _sleep(Math.Clamp(delay, 0, DelayLimitMs));
                    return JsonSerializer.Serialize(new { ok = true, restored = RestoreIfOurs() });
                default:
                    return null;
            }
        }

        private string Stage(string text, bool restore)
        {
            var complete = true;
            if (restore)
            {
                if (store.Read() is not { } read) return JsonSerializer.Serialize(new { ok = false, code = "busy" });
                _saved = read.Entries;
                complete = read.Complete;
            }
            if (store.Write(text) is not { } sequence)
            {
                // 写入可能已经清空了剪贴板，尽量换回原内容。
                if (_saved is not null) store.Restore(_saved);
                _saved = null;
                return JsonSerializer.Serialize(new { ok = false, code = "write_failed" });
            }
            _written = sequence;
            return JsonSerializer.Serialize(new { ok = true, complete });
        }

        internal void EndOfInput()
        {
            if (!Finished) RestoreIfOurs();
        }

        // 期间用户或其他程序复制了新内容（序号变了）时保留新内容，不覆盖。
        private bool RestoreIfOurs()
        {
            Finished = true;
            var saved = _saved;
            _saved = null;
            return saved is not null && _written is { } written && store.Sequence == written && store.Restore(saved);
        }
    }

    /// <summary>Win32 剪贴板。不指定所有者窗口打开：本进程不处理窗口消息，指定窗口会让别的程序清空剪贴板时等待它。</summary>
    internal sealed class SystemClipboard : IClipboardStore
    {
        private const uint CfBitmap = 2, CfMetafilePict = 3, CfPalette = 9, CfUnicodeText = 13, CfEnhMetafile = 14;
        private const uint GmemMoveable = 0x0002;

        public uint Sequence => GetClipboardSequenceNumber();

        public (List<ClipboardEntry> Entries, bool Complete)? Read()
        {
            if (!Open()) return null;
            try
            {
                var entries = new List<ClipboardEntry>();
                var complete = true;
                for (var format = EnumClipboardFormats(0); format != 0; format = EnumClipboardFormats(format))
                {
                    // 位图、调色板和旧式图元文件是 GDI 句柄，系统会从保存下来的 DIB 和增强型图元文件重新生成。
                    if (format is CfBitmap or CfPalette or CfMetafilePict) continue;
                    var handle = GetClipboardData(format);
                    if (handle == IntPtr.Zero) { complete = false; continue; }
                    if (format == CfEnhMetafile)
                    {
                        var size = GetEnhMetaFileBits(handle, 0, null);
                        var bits = new byte[size];
                        if (size == 0 || GetEnhMetaFileBits(handle, size, bits) != size) { complete = false; continue; }
                        entries.Add(new ClipboardEntry(format, bits, Metafile: true));
                        continue;
                    }
                    // 其余格式（含程序注册的格式）是全局内存块；其他句柄类型无法安全复制。
                    if (format is >= 0x0080 and <= 0x008E or >= 0x0200 and <= 0x03FF) { complete = false; continue; }
                    var length = (long)(ulong)GlobalSize(handle);
                    var pointer = length > 0 ? GlobalLock(handle) : IntPtr.Zero;
                    if (pointer == IntPtr.Zero || length > int.MaxValue) { complete = false; continue; }
                    try
                    {
                        var data = new byte[length];
                        Marshal.Copy(pointer, data, 0, (int)length);
                        entries.Add(new ClipboardEntry(format, data, Metafile: false));
                    }
                    finally { GlobalUnlock(handle); }
                }
                return (entries, complete);
            }
            finally { CloseClipboard(); }
        }

        public uint? Write(string text)
        {
            if (!Open()) return null;
            try
            {
                if (!EmptyClipboard() || !SetGlobal(CfUnicodeText, Encoding.Unicode.GetBytes(text + "\0"))) return null;
                // 不进入剪贴板历史（Win+V）和云剪贴板，剪贴板监视程序也应忽略。
                var zero = BitConverter.GetBytes(0);
                SetGlobal(RegisterClipboardFormat("ExcludeClipboardContentFromMonitorProcessing"), zero);
                SetGlobal(RegisterClipboardFormat("CanIncludeInClipboardHistory"), zero);
                SetGlobal(RegisterClipboardFormat("CanUploadToCloudClipboard"), zero);
            }
            finally { CloseClipboard(); }
            return GetClipboardSequenceNumber();
        }

        public bool Restore(IReadOnlyList<ClipboardEntry> entries)
        {
            if (!Open()) return false;
            try
            {
                if (!EmptyClipboard()) return false;
                var ok = true;
                foreach (var entry in entries)
                {
                    if (entry.Metafile)
                    {
                        var metafile = SetEnhMetaFileBits((uint)entry.Data.Length, entry.Data);
                        if (metafile == IntPtr.Zero || SetClipboardData(entry.Format, metafile) == IntPtr.Zero)
                        {
                            if (metafile != IntPtr.Zero) DeleteEnhMetaFile(metafile);
                            ok = false;
                        }
                    }
                    else ok &= SetGlobal(entry.Format, entry.Data);
                }
                return ok;
            }
            finally { CloseClipboard(); }
        }

        // 剪贴板可能正被别的程序短暂打开，最多重试约 1 秒。
        private static bool Open()
        {
            for (var attempt = 0; attempt < 20; attempt++)
            {
                if (OpenClipboard(IntPtr.Zero)) return true;
                Thread.Sleep(50);
            }
            return false;
        }

        private static bool SetGlobal(uint format, byte[] data)
        {
            if (format == 0) return false;
            var handle = GlobalAlloc(GmemMoveable, (UIntPtr)Math.Max(1, data.Length));
            if (handle == IntPtr.Zero) return false;
            var pointer = GlobalLock(handle);
            if (pointer == IntPtr.Zero) { GlobalFree(handle); return false; }
            Marshal.Copy(data, 0, pointer, data.Length);
            GlobalUnlock(handle);
            // 成功后内存归系统所有；失败时由我们释放。
            if (SetClipboardData(format, handle) != IntPtr.Zero) return true;
            GlobalFree(handle);
            return false;
        }
    }

    // MARK: 公用

    private static byte[]? ReadAll(Stream input, int limit)
    {
        using var buffer = new MemoryStream();
        var chunk = new byte[81920];
        int read;
        while ((read = input.Read(chunk, 0, chunk.Length)) > 0)
        {
            if (buffer.Length + read > limit) return null;
            buffer.Write(chunk, 0, read);
        }
        return buffer.ToArray();
    }

    private static void WriteJson(object value)
    {
        using var output = Console.OpenStandardOutput();
        var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
        output.Write(Encoding.UTF8.GetBytes(JsonSerializer.Serialize(value, options) + "\n"));
        output.Flush();
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct LastInputInfo
    {
        public uint Size;
        public uint Time;
    }

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetLastInputInfo(ref LastInputInfo info);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool OpenClipboard(IntPtr owner);

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool EmptyClipboard();

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint EnumClipboardFormats(uint format);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr GetClipboardData(uint format);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SetClipboardData(uint format, IntPtr memory);

    [DllImport("user32.dll")]
    private static extern uint GetClipboardSequenceNumber();

    [DllImport("user32.dll", EntryPoint = "RegisterClipboardFormatW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint RegisterClipboardFormat(string format);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalLock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GlobalUnlock(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern UIntPtr GlobalSize(IntPtr memory);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GlobalFree(IntPtr memory);

    [DllImport("gdi32.dll")]
    private static extern uint GetEnhMetaFileBits(IntPtr metafile, uint size, byte[]? data);

    [DllImport("gdi32.dll")]
    private static extern IntPtr SetEnhMetaFileBits(uint size, byte[] data);

    [DllImport("gdi32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool DeleteEnhMetaFile(IntPtr metafile);
}

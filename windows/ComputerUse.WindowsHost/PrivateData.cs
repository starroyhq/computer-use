using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Text.Json;

namespace ComputerUse.WindowsHost;

internal static class PrivateData
{
    internal static readonly string DirectoryPath = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Computer Use");
    internal static readonly string DiscoveryPath = Path.Combine(DirectoryPath, "runtime-pipe.json");

    internal static void ValidateDirectory(string directoryPath)
    {
        FileAttributes attributes;
        try { attributes = File.GetAttributes(directoryPath); }
        catch (FileNotFoundException) { return; }
        catch (DirectoryNotFoundException) { return; }
        var directory = new DirectoryInfo(directoryPath);
        var current = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Cannot identify current user.");
        if (attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("Computer Use data directory must not contain reparse points.");
        if (!attributes.HasFlag(FileAttributes.Directory))
            throw new IOException("Computer Use data directory must be a directory.");
        if (!current.Equals(directory.GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier))))
            throw new UnauthorizedAccessException("Computer Use data directory is not owned by the current user.");
    }

    internal static void EnsureDirectory(string? directoryPath = null)
    {
        var directory = new DirectoryInfo(directoryPath ?? DirectoryPath);
        directory.Create();
        var current = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Cannot identify current user.");
        SecureDirectory(directory, current);
    }

    internal static T? ReadPrivateJson<T>(string path) => WithFileLock(path, () =>
    {
        try
        {
            using var stream = OpenPrivateReadCore(path);
            return JsonSerializer.Deserialize<T>(stream, new JsonSerializerOptions(JsonSerializerDefaults.Web));
        }
        catch (FileNotFoundException) { return default; }
        catch (DirectoryNotFoundException) { return default; }
    });

    internal static FileStream OpenPrivateRead(string path) => WithFileLock(path, () => OpenPrivateReadCore(path));

    private static FileStream OpenPrivateReadCore(string path)
    {
        CheckPrivateFile(new FileInfo(path));
        // Startup polling must not block the host's atomic state replacement.
        // Publication never writes the file in place. The shared write access
        // also permits replacement's metadata operations while readers exist.
        // Existing readers keep their original complete file after the rename.
        return new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
    }

    internal static void WritePrivateJson<T>(string path, T value) => WithFileLock(path, () =>
    {
        var file = new FileInfo(path);
        if (file.Exists) CheckPrivateFile(file);
        var temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            using (var stream = new FileStream(temporary, new FileStreamOptions
            {
                Mode = FileMode.CreateNew, Access = FileAccess.Write, Share = FileShare.None,
                Options = FileOptions.WriteThrough
            }))
            {
                JsonSerializer.Serialize(stream, value, new JsonSerializerOptions(JsonSerializerDefaults.Web));
                stream.Flush(true);
            }
            // MoveFileEx(REPLACE_EXISTING) rejects a destination with an open
            // reader even when it shares delete access. ReplaceFile preserves
            // the old reader's snapshot while atomically publishing this file.
            if (file.Exists) File.Replace(temporary, path, null);
            else File.Move(temporary, path);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
        return true;
    });

    internal static string FileLockName(string path)
    {
        var user = WindowsIdentity.GetCurrent().User?.Value ?? throw new InvalidOperationException("Cannot identify current user.");
        var identity = user + "\n" + Path.GetFullPath(path).ToUpperInvariant();
        // AppData is shared by this user's Windows sessions; Local would not
        // serialize publication against a reader in another session.
        return @"Global\ComputerUse.PrivateData." + Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(identity)));
    }

    private static T WithFileLock<T>(string path, Func<T> action)
    {
        using var mutex = new Mutex(false, FileLockName(path));
        var acquired = false;
        try
        {
            try { acquired = mutex.WaitOne(TimeSpan.FromSeconds(2)); }
            catch (AbandonedMutexException) { acquired = true; }
            if (!acquired) throw new IOException("Timed out waiting for private state access.", unchecked((int)0x800705B4));
            return action();
        }
        finally { if (acquired) mutex.ReleaseMutex(); }
    }

    private static void CheckPrivateFile(FileInfo file)
    {
        if (File.GetAttributes(file.FullName).HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("Computer Use state file must not be a reparse point.");
        var current = WindowsIdentity.GetCurrent().User ?? throw new InvalidOperationException("Cannot identify current user.");
        if (!current.Equals(file.GetAccessControl(AccessControlSections.Owner).GetOwner(typeof(SecurityIdentifier))))
            throw new UnauthorizedAccessException("Computer Use state file is not owned by the current user.");
    }

    private static void SecureDirectory(DirectoryInfo directory, SecurityIdentifier current)
    {
        directory.Refresh();
        if (directory.Attributes.HasFlag(FileAttributes.ReparsePoint))
            throw new IOException("Computer Use data directory must not contain reparse points.");
        var existing = directory.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        if (!current.Equals(existing.GetOwner(typeof(SecurityIdentifier))))
            throw new UnauthorizedAccessException("Computer Use data directory is not owned by the current user.");

        var access = new DirectorySecurity();
        access.SetOwner(current);
        access.SetAccessRuleProtection(true, false);
        access.AddAccessRule(new FileSystemAccessRule(current, FileSystemRights.FullControl,
            InheritanceFlags.ContainerInherit | InheritanceFlags.ObjectInherit,
            PropagationFlags.None, AccessControlType.Allow));
        directory.SetAccessControl(access);

        // A protected parent ACL does not rewrite older files' explicit ACLs.
        // This also covers credential exports, action logs, and browser downloads.
        foreach (var entry in directory.EnumerateFileSystemInfos())
        {
            if (entry.Attributes.HasFlag(FileAttributes.ReparsePoint))
                throw new IOException("Computer Use data directory must not contain reparse points.");
            if (entry is DirectoryInfo child) SecureDirectory(child, current);
            else if (entry is FileInfo file) SecureFile(file, current);
        }
    }

    private static void SecureFile(FileInfo file, SecurityIdentifier current)
    {
        var existing = file.GetAccessControl(AccessControlSections.Owner | AccessControlSections.Access);
        if (!current.Equals(existing.GetOwner(typeof(SecurityIdentifier))))
            throw new UnauthorizedAccessException("Computer Use state file is not owned by the current user.");
        var access = new FileSecurity();
        access.SetOwner(current);
        access.SetAccessRuleProtection(true, false);
        access.AddAccessRule(new FileSystemAccessRule(current, FileSystemRights.FullControl, AccessControlType.Allow));
        file.SetAccessControl(access);
    }

    internal static void WriteDiscovery(string pipeName) => WritePrivateJson(DiscoveryPath, new { pipeName });

    internal static void RemoveDiscovery(string pipeName)
    {
        try
        {
            WithFileLock(DiscoveryPath, () =>
            {
                using var stream = OpenPrivateReadCore(DiscoveryPath);
                using var document = JsonDocument.Parse(stream);
                if (document.RootElement.TryGetProperty("pipeName", out var value) && value.GetString() == pipeName)
                    File.Delete(DiscoveryPath);
                return true;
            });
        }
        catch (FileNotFoundException) { }
        catch (DirectoryNotFoundException) { }
        catch (JsonException) { }
        catch (UnauthorizedAccessException) { }
        catch (IOException) { }
    }
}

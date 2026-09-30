using System.Reflection;
using System.Text.Json;
using System.Windows.Forms;
using ComputerUse.WindowsHost;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        using var host = new HostApplication();
        Pump();
        try
        {
            Request(host, "one");
            Request(host, "queued");
            Check(Dialog(host)?.RequestId == "one", "first prompt visible");
            Finish(host, "queued", false);
            Finish(host, "one", false);
            Check(Dialog(host) is null, "active and queued expired prompts removed");
            Check(!Status(host).Contains("已批准"), "expiry does not show success");

            Request(host, "late");
            ClickAllow(host);
            Check(Status(host).Contains("等待运行时确认"), "pipe write is not approval");
            Check(HostRuntime.Commands.Last() == "foreground_allow:late", "one decision sent");
            Finish(host, "late", false);
            Check(Status(host).Contains("未授权"), "late approval reported as invalid");

            Request(host, "accepted");
            ClickAllow(host);
            Finish(host, "accepted", true);
            Check(Status(host) == "已批准请求", "only runtime confirmation shows success");
            var count = HostRuntime.Commands.Count;
            Finish(host, "late", false);
            Check(Status(host) == "已批准请求", "stale result ignored");
            Check(HostRuntime.Commands.Count == count, "completion does not resend a decision");

            Request(host, "stopped");
            Request(host, "also-stopped");
            Invoke(host, "StopAsync", "测试停止").GetAwaiter().GetResult();
            Pump();
            Check(Dialog(host) is null, "stop closes prompt");
            Check(HostRuntime.Commands.Count == count, "stop does not approve or deny stale prompts");
            Invoke(host, "StartAsync").GetAwaiter().GetResult();
            Pump();
            Check(Dialog(host) is null, "restart does not restore stale queue");
            Request(host, "default-deny");
            var dialog = Dialog(host)!;
            Check(dialog.AcceptButton == dialog.CancelButton, "default action is denial");
            dialog.Close();
            Pump();
            Check(HostRuntime.Commands.Last() == "foreground_deny:default-deny", "closing denies");

            // Approval grants every requested path, so the dialog must list all of them.
            var paths = Enumerable.Range(1, 25).Select(index => $@"C:\Apps\App{index}.exe").ToArray();
            Event(host, new { @event = "pair_request", clientId = "many-apps", name = "Many apps", appIds = paths, browser = false, foreground = true });
            var text = Dialog(host)?.Controls.OfType<TextBox>().Single().Text ?? "";
            Check(text.Contains("共 25 个") && paths.All(text.Contains), "pair dialog lists every requested application");
            Finish(host, "many-apps", false);
            Check(Dialog(host) is null, "expired pair prompt withdrawn");
            Console.WriteLine("PASS: Windows authorization dialog lifecycle");
        }
        finally { Invoke(host, "ExitAsync").GetAwaiter().GetResult(); }
    }

    private static void Pump() { Application.DoEvents(); Application.DoEvents(); }
    private static void Check(bool value, string message) { if (!value) throw new Exception(message); }
    private static object? Field(HostApplication host, string name) => typeof(HostApplication).GetField(name, BindingFlags.Instance | BindingFlags.NonPublic)!.GetValue(host);
    private static ApprovalDialog? Dialog(HostApplication host) => (ApprovalDialog?)Field(host, "_approvalDialog");
    private static string Status(HostApplication host) => (string)Field(host, "_status")!;
    private static Task Invoke(HostApplication host, string method, params object[] args) => (Task)typeof(HostApplication).GetMethod(method, BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(host, args)!;
    private static void Event(HostApplication host, object message)
    {
        typeof(HostApplication).GetMethod("HandleEvent", BindingFlags.Instance | BindingFlags.NonPublic)!.Invoke(host, [JsonSerializer.SerializeToElement(message)]);
        Pump();
    }
    private static void Request(HostApplication host, string id) => Event(host, new { @event = "foreground_request", sessionId = id, clientName = "Isolated UI regression", targetTitle = "No desktop driver" });
    private static void Finish(HostApplication host, string id, bool approved) => Event(host, new { @event = "decision_finished", requestId = id, approved });
    private static void ClickAllow(HostApplication host)
    {
        var dialog = Dialog(host)!;
        dialog.Controls.OfType<FlowLayoutPanel>().Single().Controls.OfType<Button>().Single(b => b.Text == "是").PerformClick();
        Pump();
    }
}

namespace ComputerUse.WindowsHost
{
    // The UI harness cannot connect to a real runtime, grant credentials, or input
    // into another app. Production runtime behavior is covered by runtime.test.ts.
    internal sealed class HostRuntime : IAsyncDisposable
    {
        internal static readonly List<string> Commands = [];
        internal string PipeName => "isolated-test";
        internal HostRuntime(Action<JsonElement> onEvent) { }
        internal Task StartAsync() => Task.CompletedTask;
        internal Task SendControlAsync(string command, string? clientId = null, string? sessionId = null)
        {
            Commands.Add(command + ":" + (clientId ?? sessionId));
            return Task.CompletedTask;
        }
        public ValueTask DisposeAsync() => ValueTask.CompletedTask;
    }
}

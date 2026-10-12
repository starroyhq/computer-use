using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;

namespace ComputerUse.WindowsHost;

// Only this runtime's Node/driver/browser descendants enter the job. The handle
// is not inherited, so a crashed GUI also terminates its entire runtime tree.
internal sealed class RuntimeProcessGroup : IDisposable
{
    private readonly SafeFileHandle _job;

    internal RuntimeProcessGroup()
    {
        using var owner = Process.GetCurrentProcess();
        _job = CreateJobObject(IntPtr.Zero, Name(owner.Id, owner.StartTime.ToUniversalTime().Ticks));
        if (_job.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
        var limits = new ExtendedLimitInformation { BasicLimitInformation = new() { LimitFlags = 0x2000 } };
        if (!SetInformationJobObject(_job, 9, ref limits, Marshal.SizeOf<ExtendedLimitInformation>()))
        {
            var error = Marshal.GetLastWin32Error();
            _job.Dispose();
            throw new Win32Exception(error);
        }
    }

    private static string Name(int processId, long startTicks) => $@"Local\ComputerUse.Runtime.{processId}.{startTicks}";

    internal static bool PreviousHasExited(int processId, long processStartTimeUtcTicks)
    {
        using var job = OpenJobObject(4, false, Name(processId, processStartTimeUtcTicks));
        if (job.IsInvalid)
        {
            var error = Marshal.GetLastWin32Error();
            if (error == 2) return true;
            throw new Win32Exception(error);
        }
        if (!QueryInformationJobObject(job, 1, out var info, Marshal.SizeOf<BasicAccountingInformation>(), IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        return info.ActiveProcesses == 0;
    }

    internal void Assign(Process process)
    {
        if (!AssignProcessToJobObject(_job, process.SafeHandle)) throw new Win32Exception(Marshal.GetLastWin32Error());
    }

    internal uint ActiveProcesses
    {
        get
        {
            if (!QueryInformationJobObject(_job, 1, out var info, Marshal.SizeOf<BasicAccountingInformation>(), IntPtr.Zero))
                throw new Win32Exception(Marshal.GetLastWin32Error());
            return info.ActiveProcesses;
        }
    }

    internal async Task StopAsync()
    {
        if (ActiveProcesses == 0) return;
        if (!TerminateJobObject(_job, 1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        var elapsed = Stopwatch.StartNew();
        while (ActiveProcesses != 0 && elapsed.Elapsed < TimeSpan.FromSeconds(3)) await Task.Delay(25);
        if (ActiveProcesses != 0) throw new IOException("Runtime processes have not exited; recovery is blocked.");
    }

    public void Dispose() => _job.Dispose();

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimitInformation
    {
        public long PerProcessUserTimeLimit, PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize, MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IoCounters
    {
        public ulong ReadOperationCount, WriteOperationCount, OtherOperationCount,
            ReadTransferCount, WriteTransferCount, OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimitInformation
    {
        public BasicLimitInformation BasicLimitInformation;
        public IoCounters IoInfo;
        public UIntPtr ProcessMemoryLimit, JobMemoryLimit, PeakProcessMemoryUsed, PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct BasicAccountingInformation
    {
        public long TotalUserTime, TotalKernelTime, ThisPeriodTotalUserTime, ThisPeriodTotalKernelTime;
        public uint TotalPageFaultCount, TotalProcesses, ActiveProcesses, TotalTerminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateJobObject(IntPtr attributes, string? name);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle OpenJobObject(uint access, [MarshalAs(UnmanagedType.Bool)] bool inherit, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(SafeFileHandle job, int informationClass,
        ref ExtendedLimitInformation information, int length);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(SafeFileHandle job, SafeProcessHandle process);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryInformationJobObject(SafeFileHandle job, int informationClass,
        out BasicAccountingInformation information, int length, IntPtr returnLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateJobObject(SafeFileHandle job, uint exitCode);
}

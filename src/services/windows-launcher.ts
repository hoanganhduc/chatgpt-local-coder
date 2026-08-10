import { createHash } from "node:crypto";

/**
 * Compiled at Windows service-install time with Windows PowerShell 5.1
 * `Add-Type -OutputType WindowsApplication`. The GUI subsystem prevents the
 * launcher itself from owning a console; CREATE_NO_WINDOW applies the same
 * guarantee to the configured console-subsystem child.
 */
export const WINDOWS_LAUNCHER_SOURCE = String.raw`using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

internal static class ChatGPTLocalCoderLauncher
{
    private const uint CREATE_SUSPENDED = 0x00000004;
    private const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;
    private const uint CREATE_NO_WINDOW = 0x08000000;
    private const uint STARTF_USESTDHANDLES = 0x00000100;
    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x00002000;
    private const int JobObjectExtendedLimitInformation = 9;
    private const uint FILE_APPEND_DATA = 0x00000004;
    private const uint GENERIC_READ = 0x80000000;
    private const uint FILE_SHARE_READ = 0x00000001;
    private const uint FILE_SHARE_WRITE = 0x00000002;
    private const uint FILE_SHARE_DELETE = 0x00000004;
    private const uint OPEN_EXISTING = 3;
    private const uint OPEN_ALWAYS = 4;
    private const uint FILE_ATTRIBUTE_NORMAL = 0x00000080;
    private const uint INFINITE = 0xffffffff;
    private const uint WAIT_OBJECT_0 = 0;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential)]
    private struct SECURITY_ATTRIBUTES
    {
        public uint nLength;
        public IntPtr lpSecurityDescriptor;
        [MarshalAs(UnmanagedType.Bool)] public bool bInheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct STARTUPINFO
    {
        public uint cb;
        public string lpReserved;
        public string lpDesktop;
        public string lpTitle;
        public uint dwX;
        public uint dwY;
        public uint dwXSize;
        public uint dwYSize;
        public uint dwXCountChars;
        public uint dwYCountChars;
        public uint dwFillAttribute;
        public uint dwFlags;
        public ushort wShowWindow;
        public ushort cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CreateProcessW(
        string applicationName,
        StringBuilder commandLine,
        IntPtr processAttributes,
        IntPtr threadAttributes,
        [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
        uint creationFlags,
        IntPtr environment,
        string currentDirectory,
        ref STARTUPINFO startupInfo,
        out PROCESS_INFORMATION processInformation);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr jobAttributes, string name);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool SetInformationJobObject(
        IntPtr job,
        int informationClass,
        ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION information,
        uint informationLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool TerminateProcess(IntPtr process, uint exitCode);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr handle);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateFileW(
        string fileName,
        uint desiredAccess,
        uint shareMode,
        ref SECURITY_ATTRIBUTES securityAttributes,
        uint creationDisposition,
        uint flagsAndAttributes,
        IntPtr templateFile);

    private sealed class Payload
    {
        public string ExecutablePath;
        public string ArgumentLine;
        public string WorkingDirectory;
        public string LogPath;
        public Dictionary<string, string> EnvironmentVariables;
    }

    private static string ReadField(BinaryReader reader)
    {
        int length = reader.ReadInt32();
        if (length < 0 || length > 16 * 1024 * 1024) throw new InvalidDataException("invalid payload field length");
        byte[] bytes = reader.ReadBytes(length);
        if (bytes.Length != length) throw new EndOfStreamException("truncated payload field");
        return new UTF8Encoding(false, true).GetString(bytes);
    }

    private static Payload DecodePayload(string encoded)
    {
        byte[] bytes = Convert.FromBase64String(encoded);
        using (MemoryStream stream = new MemoryStream(bytes, false))
        using (BinaryReader reader = new BinaryReader(stream, Encoding.UTF8))
        {
            byte[] magic = reader.ReadBytes(4);
            if (magic.Length != 4 || magic[0] != 0x43 || magic[1] != 0x4c || magic[2] != 0x43 || magic[3] != 0x32)
                throw new InvalidDataException("invalid launcher payload magic");
            Payload payload = new Payload();
            payload.ExecutablePath = ReadField(reader);
            payload.ArgumentLine = ReadField(reader);
            payload.WorkingDirectory = ReadField(reader);
            payload.LogPath = ReadField(reader);
            int environmentCount = reader.ReadInt32();
            if (environmentCount < 0 || environmentCount > 4096) throw new InvalidDataException("invalid environment count");
            payload.EnvironmentVariables = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            for (int index = 0; index < environmentCount; index++)
            {
                string name = ReadField(reader);
                string value = ReadField(reader);
                if (name.Length == 0 || name.IndexOf('=') >= 0 || name.IndexOf('\0') >= 0 || value.IndexOf('\0') >= 0)
                    throw new InvalidDataException("invalid environment entry");
                if (payload.EnvironmentVariables.ContainsKey(name)) throw new InvalidDataException("duplicate environment entry");
                payload.EnvironmentVariables.Add(name, value);
            }
            if (stream.Position != stream.Length) throw new InvalidDataException("trailing launcher payload data");
            if (!Path.IsPathRooted(payload.ExecutablePath) || !Path.IsPathRooted(payload.WorkingDirectory) || !Path.IsPathRooted(payload.LogPath))
                throw new InvalidDataException("launcher paths must be absolute");
            if (payload.ExecutablePath.IndexOf('\0') >= 0 || payload.ExecutablePath.IndexOf('"') >= 0 ||
                payload.ArgumentLine.IndexOf('\0') >= 0)
                throw new InvalidDataException("invalid native process command");
            return payload;
        }
    }

    private static IntPtr BuildEnvironmentBlock(Dictionary<string, string> overrides)
    {
        SortedDictionary<string, string> environment = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        foreach (DictionaryEntry entry in System.Environment.GetEnvironmentVariables())
            environment[(string)entry.Key] = (string)entry.Value;
        foreach (KeyValuePair<string, string> entry in overrides)
            environment[entry.Key] = entry.Value;
        StringBuilder block = new StringBuilder();
        foreach (KeyValuePair<string, string> entry in environment)
            block.Append(entry.Key).Append('=').Append(entry.Value).Append('\0');
        block.Append('\0');
        return Marshal.StringToHGlobalUni(block.ToString());
    }

    private static void AppendError(string logPath, string message)
    {
        try { File.AppendAllText(logPath, "[native-launcher] " + message + Environment.NewLine, Encoding.UTF8); }
        catch { }
    }

    private static int Main(string[] args)
    {
        Payload payload = null;
        IntPtr job = IntPtr.Zero;
        IntPtr input = INVALID_HANDLE_VALUE;
        IntPtr output = INVALID_HANDLE_VALUE;
        IntPtr environment = IntPtr.Zero;
        PROCESS_INFORMATION process = new PROCESS_INFORMATION();
        bool childCreated = false;
        bool childCompleted = false;
        try
        {
            if (args.Length != 1) throw new InvalidDataException("expected one opaque launcher payload");
            payload = DecodePayload(args[0]);
            Directory.CreateDirectory(Path.GetDirectoryName(payload.LogPath));

            SECURITY_ATTRIBUTES inheritable = new SECURITY_ATTRIBUTES();
            inheritable.nLength = (uint)Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES));
            inheritable.bInheritHandle = true;
            output = CreateFileW(payload.LogPath, FILE_APPEND_DATA,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, ref inheritable,
                OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (output == INVALID_HANDLE_VALUE) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "open service log");
            input = CreateFileW("NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE,
                ref inheritable, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, IntPtr.Zero);
            if (input == INVALID_HANDLE_VALUE) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "open NUL stdin");

            job = CreateJobObject(IntPtr.Zero, null);
            if (job == IntPtr.Zero) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "create job object");
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref limits,
                (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION))))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "configure job object");

            STARTUPINFO startup = new STARTUPINFO();
            startup.cb = (uint)Marshal.SizeOf(typeof(STARTUPINFO));
            startup.dwFlags = STARTF_USESTDHANDLES;
            startup.hStdInput = input;
            startup.hStdOutput = output;
            startup.hStdError = output;
            string command = "\"" + payload.ExecutablePath + "\"" +
                (payload.ArgumentLine.Length == 0 ? "" : " " + payload.ArgumentLine);
            environment = BuildEnvironmentBlock(payload.EnvironmentVariables);
            uint flags = CREATE_NO_WINDOW | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT;
            if (!CreateProcessW(payload.ExecutablePath, new StringBuilder(command), IntPtr.Zero, IntPtr.Zero,
                true, flags, environment, payload.WorkingDirectory, ref startup, out process))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "create native child");
            childCreated = true;
            if (!AssignProcessToJobObject(job, process.hProcess))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "assign child to job");
            if (ResumeThread(process.hThread) == 0xffffffff)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "resume child");
            if (WaitForSingleObject(process.hProcess, INFINITE) != WAIT_OBJECT_0)
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "wait for child");
            childCompleted = true;
            uint exitCode;
            if (!GetExitCodeProcess(process.hProcess, out exitCode))
                throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "read child exit code");
            return unchecked((int)exitCode);
        }
        catch (Exception error)
        {
            if (payload != null) AppendError(payload.LogPath, error.Message);
            return 1;
        }
        finally
        {
            if (childCreated && !childCompleted && process.hProcess != IntPtr.Zero)
            {
                TerminateProcess(process.hProcess, 1);
                WaitForSingleObject(process.hProcess, 5000);
            }
            if (process.hThread != IntPtr.Zero) CloseHandle(process.hThread);
            if (process.hProcess != IntPtr.Zero) CloseHandle(process.hProcess);
            if (job != IntPtr.Zero) CloseHandle(job);
            if (environment != IntPtr.Zero) Marshal.FreeHGlobal(environment);
            if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
            if (output != INVALID_HANDLE_VALUE) CloseHandle(output);
        }
    }
}
`;

export const WINDOWS_LAUNCHER_SOURCE_SHA256 = createHash("sha256")
  .update(WINDOWS_LAUNCHER_SOURCE, "utf8")
  .digest("hex");

export const WINDOWS_LAUNCHER_BASENAME = `ChatGPTLocalCoderLauncher-${WINDOWS_LAUNCHER_SOURCE_SHA256}`;

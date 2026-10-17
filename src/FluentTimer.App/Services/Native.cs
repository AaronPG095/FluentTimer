using System.Runtime.InteropServices;

namespace FluentTimer.App.Services;

internal static partial class Native
{
    public const int WM_HOTKEY = 0x0312;
    public const int GWL_EXSTYLE = -20;
    public const int WS_EX_TOOLWINDOW = 0x00000080;
    public const int WS_EX_NOACTIVATE = 0x08000000;
    public static readonly IntPtr HWND_MESSAGE = new(-3);

    [Flags]
    public enum Modifiers : uint { None = 0, Alt = 1, Ctrl = 2, Shift = 4, Win = 8, NoRepeat = 0x4000 }

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool RegisterHotKey(IntPtr hWnd, int id, uint modifiers, uint vk);

    [LibraryImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool UnregisterHotKey(IntPtr hWnd, int id);

    [LibraryImport("user32.dll")]
    public static partial uint GetDoubleClickTime();

    [StructLayout(LayoutKind.Sequential)]
    public struct LASTINPUTINFO
    {
        public uint cbSize;
        public uint dwTime;
    }

    [LibraryImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetLastInputInfo(ref LASTINPUTINFO info);

    /// <summary>How long since the last keyboard or mouse input.</summary>
    public static TimeSpan IdleTime()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return TimeSpan.Zero;
        return TimeSpan.FromMilliseconds(unchecked((uint)Environment.TickCount - info.dwTime));
    }

    // QUNS_BUSY = 2, QUNS_RUNNING_D3D_FULL_SCREEN = 3, QUNS_PRESENTATION_MODE = 4
    [LibraryImport("shell32.dll")]
    public static partial int SHQueryUserNotificationState(out int state);

    [LibraryImport("user32.dll")]
    public static partial IntPtr GetForegroundWindow();

    [LibraryImport("user32.dll")]
    public static partial uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    /// <summary>A game, video or presentation is full-screen (our own break overlay doesn't count).</summary>
    public static bool IsFullscreenAppActive()
    {
        if (SHQueryUserNotificationState(out var state) != 0 || state is not (2 or 3 or 4)) return false;
        GetWindowThreadProcessId(GetForegroundWindow(), out var pid);
        return pid != (uint)Environment.ProcessId;
    }

    [LibraryImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    public static partial IntPtr GetWindowLongPtr(IntPtr hWnd, int index);

    [LibraryImport("user32.dll", EntryPoint = "SetWindowLongPtrW")]
    public static partial IntPtr SetWindowLongPtr(IntPtr hWnd, int index, IntPtr value);

    public static void AddExStyle(IntPtr hwnd, int flags)
    {
        var style = GetWindowLongPtr(hwnd, GWL_EXSTYLE).ToInt64();
        SetWindowLongPtr(hwnd, GWL_EXSTYLE, new IntPtr(style | (long)flags));
    }

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    public struct MONITORINFO
    {
        public int cbSize;
        public RECT rcMonitor;
        public RECT rcWork;
        public uint dwFlags;
    }

    [LibraryImport("user32.dll")]
    public static partial IntPtr MonitorFromPoint(POINT pt, uint flags);

    [LibraryImport("user32.dll", EntryPoint = "GetMonitorInfoW")]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static partial bool GetMonitorInfo(IntPtr monitor, ref MONITORINFO info);

    /// <summary>Work area (physical pixels) of the monitor nearest to a physical-pixel point.</summary>
    public static RECT WorkAreaAt(int x, int y)
    {
        var mon = MonitorFromPoint(new POINT { X = x, Y = y }, 2 /* MONITOR_DEFAULTTONEAREST */);
        var info = new MONITORINFO { cbSize = Marshal.SizeOf<MONITORINFO>() };
        GetMonitorInfo(mon, ref info);
        return info.rcWork;
    }
}

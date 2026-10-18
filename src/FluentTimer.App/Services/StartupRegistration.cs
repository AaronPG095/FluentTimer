using Microsoft.Win32;

namespace FluentTimer.App.Services;

/// <summary>
/// Per-user auto-start via HKCU\Software\Microsoft\Windows\CurrentVersion\Run (no admin needed), plus the
/// matching record in Explorer's StartupApproved list, which is what Task Manager → Startup apps reads and writes.
/// Without an explicit "enabled" record, Windows (or a startup-manager tool) may skip a newly added entry.
/// </summary>
internal static class StartupRegistration
{
    private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
    private const string ApprovedKey = @"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    private const string ValueName = "FluentTimer";
    public const string MinimizedArg = "--minimized";

    // First byte 0x02 = enabled; odd values (0x03, 0x07) = disabled by the user. The rest is a timestamp (zero = none).
    private static readonly byte[] EnabledRecord = [2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    private static string Command => $"\"{Environment.ProcessPath}\" {MinimizedArg}";

    public static bool IsEnabled()
    {
        using var key = Registry.CurrentUser.OpenSubKey(RunKey);
        return key?.GetValue(ValueName) is string;
    }

    /// <summary>
    /// Creates (or repoints, if the exe moved) a "Fluent Timer" shortcut in the user's Start menu,
    /// so the app can always be started by searching for it.
    /// </summary>
    public static void EnsureStartMenuShortcut()
    {
        if (Environment.ProcessPath is not { } exe) return;
        var programs = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
        var link = System.IO.Path.Combine(programs, "Fluent Timer.lnk");
        var shellType = Type.GetTypeFromProgID("WScript.Shell");
        if (shellType is null) return;
        dynamic shell = Activator.CreateInstance(shellType)!;
        try
        {
            dynamic shortcut = shell.CreateShortcut(link);
            if (System.IO.File.Exists(link) && string.Equals((string)shortcut.TargetPath, exe, StringComparison.OrdinalIgnoreCase)) return;
            shortcut.TargetPath = exe;
            shortcut.WorkingDirectory = System.IO.Path.GetDirectoryName(exe);
            shortcut.Description = "Fluent Timer";
            shortcut.IconLocation = exe + ",0";
            shortcut.Save();
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FinalReleaseComObject(shell);
        }
    }

    /// <summary>True when the Startup-apps list explicitly has Fluent Timer switched off (e.g. in Task Manager).</summary>
    public static bool IsDisabledInWindows()
    {
        using var key = Registry.CurrentUser.OpenSubKey(ApprovedKey);
        return key?.GetValue(ValueName) is byte[] { Length: > 0 } b && (b[0] & 1) == 1;
    }

    /// <summary>
    /// Adds, refreshes (if the exe moved) or removes the Run entry.
    /// <paramref name="userChoice"/>: the user just switched it on in Settings, so also clear a "disabled" record.
    /// On routine startup the record is only created if missing, so a choice made in Task Manager is respected.
    /// </summary>
    public static void Apply(bool enabled, bool userChoice = false)
    {
        using (var run = Registry.CurrentUser.CreateSubKey(RunKey, writable: true))
        {
            if (enabled)
            {
                if (run.GetValue(ValueName) as string != Command) run.SetValue(ValueName, Command);
            }
            else if (run.GetValue(ValueName) is not null)
            {
                run.DeleteValue(ValueName);
            }
        }

        using var approved = Registry.CurrentUser.CreateSubKey(ApprovedKey, writable: true);
        if (!enabled)
        {
            if (approved.GetValue(ValueName) is not null) approved.DeleteValue(ValueName);
        }
        else if (userChoice || approved.GetValue(ValueName) is not byte[])
        {
            approved.SetValue(ValueName, EnabledRecord, RegistryValueKind.Binary);
        }
    }
}

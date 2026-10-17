using System.Windows.Input;
using System.Windows.Interop;

namespace FluentTimer.App.Services;

/// <summary>System-wide hotkey registered on an invisible message-only window.</summary>
internal sealed class HotkeyService : IDisposable
{
    private const int HotkeyId = 0x4654; // "FT"
    private readonly HwndSource _source;
    private bool _registered;

    public HotkeyService()
    {
        _source = new HwndSource(new HwndSourceParameters("FluentTimer.Hotkey")
        {
            ParentWindow = Native.HWND_MESSAGE,
            Width = 0,
            Height = 0,
            WindowStyle = 0,
        });
        _source.AddHook(WndProc);
    }

    public event Action? Pressed;

    /// <summary>Registers e.g. "Ctrl+Alt+T". Returns false if invalid or already taken by another app.</summary>
    public bool Register(string gesture, out string error)
    {
        Unregister();
        if (!TryParse(gesture, out var mods, out var key))
        {
            error = "Not a valid shortcut";
            return false;
        }
        var vk = (uint)KeyInterop.VirtualKeyFromKey(key);
        _registered = Native.RegisterHotKey(_source.Handle, HotkeyId, (uint)(mods | Native.Modifiers.NoRepeat), vk);
        error = _registered ? "" : "Already used by another app";
        return _registered;
    }

    public void Unregister()
    {
        if (!_registered) return;
        Native.UnregisterHotKey(_source.Handle, HotkeyId);
        _registered = false;
    }

    public static bool TryParse(string gesture, out Native.Modifiers mods, out Key key)
    {
        mods = Native.Modifiers.None;
        key = Key.None;
        foreach (var raw in gesture.Split('+', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
        {
            switch (raw.ToLowerInvariant())
            {
                case "ctrl" or "control": mods |= Native.Modifiers.Ctrl; break;
                case "alt": mods |= Native.Modifiers.Alt; break;
                case "shift": mods |= Native.Modifiers.Shift; break;
                case "win" or "windows": mods |= Native.Modifiers.Win; break;
                default:
                    if (key != Key.None || !Enum.TryParse(raw, ignoreCase: true, out key)) return false;
                    break;
            }
        }
        // Require a modifier so plain typing is never hijacked.
        return key != Key.None && mods != Native.Modifiers.None;
    }

    /// <summary>Formats a key event from a recorder box, e.g. "Ctrl+Shift+Space". Empty while only modifiers are held.</summary>
    public static string Format(ModifierKeys mods, Key key)
    {
        if (key is Key.LeftCtrl or Key.RightCtrl or Key.LeftAlt or Key.RightAlt or Key.LeftShift or Key.RightShift
            or Key.LWin or Key.RWin or Key.System or Key.None) return "";
        var parts = new List<string>();
        if (mods.HasFlag(ModifierKeys.Control)) parts.Add("Ctrl");
        if (mods.HasFlag(ModifierKeys.Alt)) parts.Add("Alt");
        if (mods.HasFlag(ModifierKeys.Shift)) parts.Add("Shift");
        if (mods.HasFlag(ModifierKeys.Windows)) parts.Add("Win");
        parts.Add(key.ToString());
        return string.Join("+", parts);
    }

    private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
    {
        if (msg == Native.WM_HOTKEY && wParam.ToInt32() == HotkeyId)
        {
            handled = true;
            Pressed?.Invoke();
        }
        return IntPtr.Zero;
    }

    public void Dispose()
    {
        Unregister();
        _source.Dispose();
    }
}

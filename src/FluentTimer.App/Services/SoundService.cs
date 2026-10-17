using System.IO;
using System.Media;
using System.Windows.Media;
using FluentTimer.Core;

namespace FluentTimer.App.Services;

/// <summary>Plays one alert sound at a time: synthesized built-ins via SoundPlayer, custom files via MediaPlayer.</summary>
internal sealed class SoundService : IDisposable
{
    private SoundPlayer? _wavPlayer;
    private MediaPlayer? _mediaPlayer;
    private bool _loopMedia;

    public void Play(AlertSettings settings, bool loud = false, bool forceOnce = false)
    {
        Stop();
        var sound = settings.Sound;
        if (string.Equals(sound, "None", StringComparison.OrdinalIgnoreCase)) return;
        var volume = loud ? 1.0 : settings.Volume;
        var loop = settings.LoopSound && !forceOnce;

        if (!SoundSynth.IsBuiltIn(sound) && File.Exists(sound))
        {
            _loopMedia = loop;
            _mediaPlayer = new MediaPlayer { Volume = volume };
            _mediaPlayer.MediaEnded += OnMediaEnded;
            _mediaPlayer.MediaFailed += (_, _) => PlayBuiltIn("Chime", volume, loop);
            _mediaPlayer.Open(new Uri(sound));
            _mediaPlayer.Play();
            return;
        }

        PlayBuiltIn(SoundSynth.IsBuiltIn(sound) ? sound : "Chime", volume, loop);
    }

    private void PlayBuiltIn(string name, double volume, bool loop)
    {
        _wavPlayer = new SoundPlayer(new MemoryStream(SoundSynth.Render(name, volume)));
        if (loop) _wavPlayer.PlayLooping();
        else _wavPlayer.Play();
    }

    private void OnMediaEnded(object? sender, EventArgs e)
    {
        if (!_loopMedia || _mediaPlayer is null) return;
        _mediaPlayer.Position = TimeSpan.Zero;
        _mediaPlayer.Play();
    }

    public void Stop()
    {
        _wavPlayer?.Stop();
        _wavPlayer?.Dispose();
        _wavPlayer = null;
        if (_mediaPlayer is not null)
        {
            _mediaPlayer.MediaEnded -= OnMediaEnded;
            _mediaPlayer.Stop();
            _mediaPlayer.Close();
            _mediaPlayer = null;
        }
    }

    public void Dispose() => Stop();
}

namespace FluentTimer.Core;

/// <summary>
/// Generates the built-in alert sounds as 16-bit mono WAV bytes, so no audio files ship with the app.
/// </summary>
public static class SoundSynth
{
    public const int SampleRate = 44100;
    public static readonly string[] BuiltIn = ["Chime", "Bell", "Digital", "Soft"];

    public static bool IsBuiltIn(string name) => BuiltIn.Contains(name, StringComparer.OrdinalIgnoreCase);

    public static byte[] Render(string name, double volume)
    {
        var samples = name.ToLowerInvariant() switch
        {
            "bell" => Bell(),
            "digital" => Digital(),
            "soft" => Soft(),
            _ => Chime(),
        };
        return ToWav(samples, Math.Clamp(volume, 0, 1));
    }

    private static float[] Chime()
    {
        var buf = Buffer(1.6);
        Tone(buf, 0.00, 1318.5, 0.9, 0.55); // E6
        Tone(buf, 0.22, 1046.5, 1.2, 0.55); // C6
        return buf;
    }

    private static float[] Bell()
    {
        var buf = Buffer(2.0);
        foreach (var (ratio, amp) in new[] { (1.0, 0.6), (2.0, 0.25), (3.0, 0.12), (4.2, 0.08) })
            Tone(buf, 0, 880 * ratio, 1.6 / ratio, amp);
        return buf;
    }

    private static float[] Digital()
    {
        var buf = Buffer(1.2);
        foreach (var start in new[] { 0.0, 0.14, 0.28, 0.6, 0.74, 0.88 })
            Beep(buf, start, 2000, 0.08, 0.35);
        return buf;
    }

    private static float[] Soft()
    {
        var buf = Buffer(1.8);
        Tone(buf, 0.00, 523.25, 0.5, 0.5);  // C5
        Tone(buf, 0.18, 659.25, 0.5, 0.45); // E5
        Tone(buf, 0.36, 783.99, 0.8, 0.45); // G5
        return buf;
    }

    private static float[] Buffer(double seconds) => new float[(int)(seconds * SampleRate)];

    /// <summary>A sine partial with a soft attack and exponential decay.</summary>
    private static void Tone(float[] buf, double start, double freq, double decay, double amp)
    {
        var first = (int)(start * SampleRate);
        for (var i = first; i < buf.Length; i++)
        {
            var t = (i - first) / (double)SampleRate;
            var env = Math.Min(1, t / 0.005) * Math.Exp(-t / decay * 3);
            buf[i] += (float)(amp * env * Math.Sin(2 * Math.PI * freq * t));
        }
    }

    private static void Beep(float[] buf, double start, double freq, double length, double amp)
    {
        var first = (int)(start * SampleRate);
        var count = (int)(length * SampleRate);
        for (var i = 0; i < count && first + i < buf.Length; i++)
        {
            var t = i / (double)SampleRate;
            var edge = Math.Min(1, Math.Min(t, length - t) / 0.004); // avoid clicks
            buf[first + i] += (float)(amp * edge * Math.Sign(Math.Sin(2 * Math.PI * freq * t)) * 0.6);
        }
    }

    public static byte[] ToWav(float[] samples, double volume)
    {
        var peak = samples.Length == 0 ? 1 : Math.Max(1e-6, samples.Max(Math.Abs));
        var scale = volume * 0.9 / Math.Max(1, peak);
        var dataLen = samples.Length * 2;
        using var ms = new MemoryStream(44 + dataLen);
        using var w = new BinaryWriter(ms);
        w.Write("RIFF"u8);
        w.Write(36 + dataLen);
        w.Write("WAVE"u8);
        w.Write("fmt "u8);
        w.Write(16);
        w.Write((short)1);              // PCM
        w.Write((short)1);              // mono
        w.Write(SampleRate);
        w.Write(SampleRate * 2);        // byte rate
        w.Write((short)2);              // block align
        w.Write((short)16);             // bits per sample
        w.Write("data"u8);
        w.Write(dataLen);
        foreach (var s in samples)
            w.Write((short)Math.Clamp(s * scale * short.MaxValue, short.MinValue, short.MaxValue));
        w.Flush();
        return ms.ToArray();
    }
}

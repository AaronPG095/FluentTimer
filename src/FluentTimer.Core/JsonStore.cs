using System.Text.Json;
using System.Text.Json.Serialization;

namespace FluentTimer.Core;

/// <summary>Reads and atomically writes one JSON file. A corrupt file is kept aside, not lost.</summary>
public sealed class JsonStore<T> where T : class
{
    public static readonly JsonSerializerOptions Options = new()
    {
        WriteIndented = true,
        Converters = { new JsonStringEnumConverter() },
    };

    private readonly Func<T> _createDefault;
    private readonly object _gate = new();

    public JsonStore(string path, Func<T> createDefault)
    {
        Path = path;
        _createDefault = createDefault;
    }

    public string Path { get; }

    public T Load()
    {
        try
        {
            if (!File.Exists(Path)) return _createDefault();
            using var stream = File.OpenRead(Path);
            return JsonSerializer.Deserialize<T>(stream, Options) ?? _createDefault();
        }
        catch (JsonException)
        {
            File.Copy(Path, Path + ".corrupt", overwrite: true);
            return _createDefault();
        }
    }

    public void Save(T value)
    {
        lock (_gate)
        {
            Directory.CreateDirectory(System.IO.Path.GetDirectoryName(Path)!);
            var temp = Path + ".tmp";
            File.WriteAllText(temp, JsonSerializer.Serialize(value, Options));
            File.Move(temp, Path, overwrite: true);
        }
    }
}

public static class AppPaths
{
    /// <summary>%AppData%\FluentTimer, or FLUENTTIMER_DATA for development and testing.</summary>
    public static string DataDir { get; } =
        Environment.GetEnvironmentVariable("FLUENTTIMER_DATA") is { Length: > 0 } dev
            ? dev
            : System.IO.Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "FluentTimer");

    /// <summary>Set FLUENTTIMER_DEV=1 to leave the Windows startup (Run key) untouched.</summary>
    public static bool IsDev => Environment.GetEnvironmentVariable("FLUENTTIMER_DEV") == "1";

    public static string Settings => System.IO.Path.Combine(DataDir, "settings.json");
    public static string State => System.IO.Path.Combine(DataDir, "state.json");
    public static string History => System.IO.Path.Combine(DataDir, "history.json");
}

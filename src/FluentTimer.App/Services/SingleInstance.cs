namespace FluentTimer.App.Services;

/// <summary>Ensures one running copy. A second launch asks the first to show its window, then exits.</summary>
internal sealed class SingleInstance : IDisposable
{
    private const string MutexName = @"Local\FluentTimer.SingleInstance";
    private const string EventName = @"Local\FluentTimer.Activate";

    private readonly Mutex _mutex;
    private readonly EventWaitHandle _activate;
    private readonly RegisteredWaitHandle? _wait;

    private SingleInstance(Mutex mutex, EventWaitHandle activate, Action onActivate)
    {
        _mutex = mutex;
        _activate = activate;
        _wait = ThreadPool.RegisterWaitForSingleObject(_activate, (_, _) => onActivate(), null, Timeout.Infinite, executeOnlyOnce: false);
    }

    /// <summary>Returns null when another instance is already running (and has been signalled).</summary>
    public static SingleInstance? TryAcquire(Action onActivate)
    {
        var mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
        var activate = new EventWaitHandle(false, EventResetMode.AutoReset, EventName);
        if (!createdNew)
        {
            activate.Set();
            activate.Dispose();
            mutex.Dispose();
            return null;
        }
        return new SingleInstance(mutex, activate, onActivate);
    }

    public void Dispose()
    {
        _wait?.Unregister(null);
        _activate.Dispose();
        _mutex.ReleaseMutex();
        _mutex.Dispose();
    }
}

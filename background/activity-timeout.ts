type TimerHandle = ReturnType<typeof setTimeout>;
type Schedule = (callback: () => void, delayMs: number) => TimerHandle;
type Cancel = (timer: TimerHandle) => void;

export class ModelActivityWatchdog {
  private timer: TimerHandle | null = null;
  private running = false;

  // Os defaults precisam ser wrappers: guardar o setTimeout nativo num campo e
  // chamar this.schedule(...) faz o Chrome receber a instância como receiver e
  // lançar "Illegal invocation" no service worker (Node não valida o receiver).
  constructor(
    private readonly timeoutMs: number,
    private readonly onTimeout: () => void,
    private readonly hasActiveWork: () => boolean,
    private readonly schedule: Schedule = (callback, delayMs) => setTimeout(callback, delayMs),
    private readonly cancel: Cancel = (timer) => clearTimeout(timer),
  ) {}

  start() {
    this.running = true;
    this.arm();
  }

  touch() {
    if (!this.running) return;
    this.arm();
  }

  stop() {
    this.running = false;
    if (this.timer !== null) {
      this.cancel(this.timer);
      this.timer = null;
    }
  }

  private arm() {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = this.schedule(() => this.handleTimer(), this.timeoutMs);
  }

  private handleTimer() {
    this.timer = null;
    if (!this.running) return;
    if (this.hasActiveWork()) {
      this.arm();
      return;
    }
    this.running = false;
    this.onTimeout();
  }
}

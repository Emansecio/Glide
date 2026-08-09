export class SerialTaskQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T>): Promise<T> {
    const operation = this.tail.then(task);
    this.tail = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

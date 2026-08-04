/** 同步内存镜像：启动时从后端加载一次，之后 getConfig() 同步读，避免 UI 闪烁 */
export class LazyMemo<T> {
  private value: T | undefined

  set(v: T): void {
    this.value = v
  }

  get(): T | undefined {
    return this.value
  }
}

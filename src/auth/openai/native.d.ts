declare module "os-lock" {
  export function lock(
    fd: number,
    options: { exclusive?: boolean; immediate?: boolean },
  ): Promise<void>;
  export function unlock(fd: number): Promise<void>;
}

export async function withEnvironmentVariable<T>(
  name: string,
  value: string | undefined,
  callback: () => Promise<T>,
): Promise<T> {
  const originalValue = process.env[name];

  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }

  try {
    return await callback();
  } finally {
    if (originalValue === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = originalValue;
    }
  }
}

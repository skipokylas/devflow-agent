import os from "node:os";
import path from "node:path";

export const envFile = (): string => path.join(os.homedir(), ".devflow", ".env");

/**
 * Секрети одні на всі репозиторії й лежать поза будь-яким git.
 * Файл цільового репо навмисно НЕ читаємо: чужі змінні не мають потрапляти
 * в процес агента.
 */
export function loadEnv(): void {
  try {
    process.loadEnvFile(envFile());
  } catch {
    // Немає файлу — працюємо на змінних оточення; про це скаже перша ж команда.
  }
}

const STORAGE_KEY = 'jquants-app-password';
export const APP_PASSWORD_INVALID_EVENT = 'jquants:app-password-invalid';

// タブを閉じるまで保持すれば十分なのでsessionStorageを使う(永続化はしない)。
export function getStoredAppPassword(): string | null {
  return sessionStorage.getItem(STORAGE_KEY);
}

export function setStoredAppPassword(password: string): void {
  sessionStorage.setItem(STORAGE_KEY, password);
}

export function clearStoredAppPassword(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  window.dispatchEvent(new Event(APP_PASSWORD_INVALID_EVENT));
}

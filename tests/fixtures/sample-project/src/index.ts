import { userStore } from './stores/user-store.js';

export function main() {
  return userStore.users.length;
}

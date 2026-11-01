export class PermissionDenied extends Error {
  constructor(readonly capability: string, readonly reason: string) {
    super(`You are not allowed to do that (${capability}): ${reason}.`);
  }
}

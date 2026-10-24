import type {User} from '../../shared/api/types.js';

export interface ProfileForm {username: string; password: string; confirmation: string}
export interface ProfilePatch {username?: string; password?: string}
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export function profileDirty(user: User, form: ProfileForm, avatar: boolean): boolean {
  return form.username.trim() !== (user.username ?? '') || !!form.password || !!form.confirmation || avatar;
}

export function profilePatch(user: User, form: ProfileForm): ProfilePatch {
  const name = form.username.trim();
  if (!name || Array.from(name).length > 64) throw new Error('玩家名称需为 1～64 个字符。');
  const patch: ProfilePatch = {};
  if (name !== (user.username ?? '')) patch.username = name;
  if (form.password || form.confirmation) {
    if (form.password !== form.confirmation) throw new Error('两次输入的密码不一致。');
    const bytes = new TextEncoder().encode(form.password.trim()).length;
    if (bytes < 8 || bytes > 72) throw new Error('密码需为 8～72 个 UTF-8 字节。');
    patch.password = form.password;
  }
  return patch;
}

export function validateAvatar(file: Pick<File, 'type' | 'size'>): void {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('头像仅支持 PNG、JPEG 或 WebP。');
  if (file.size === 0) throw new Error('头像文件不能为空。');
  if (file.size > MAX_AVATAR_BYTES) throw new Error('头像不能超过 5 MB。');
}

/** Coordinates in the rotated source image, clamped to prevent uncovered crop edges. */
export function cropRect(width: number, height: number, zoom: number, x: number, y: number) {
  const size = Math.min(width, height) / Math.max(1, Math.min(4, zoom));
  return {x: Math.max(0, Math.min(width - size, (width - size) / 2 + x)),
    y: Math.max(0, Math.min(height - size, (height - size) / 2 + y)), size};
}

import {api} from '../../app/session.js';
import {ApiError} from '../../shared/api/client.js';
import type {User} from '../../shared/api/types.js';
import {PlayerAvatar} from '../../shared/components/player-avatar/index.js';
import {AvatarCrop} from './avatar-crop.js';
import {profileDirty, profilePatch, type ProfileForm} from './model.js';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const fields = $<HTMLFieldSetElement>('profile-fields'), username = $<HTMLInputElement>('profile-username');
const password = $<HTMLInputElement>('profile-password'), confirmation = $<HTMLInputElement>('profile-password-confirm');
const save = $<HTMLButtonElement>('profile-save'), input = $<HTMLInputElement>('avatar-file');
const avatar = new PlayerAvatar(); $('profile-avatar').append(avatar.root);
let user: User | null = null, file: File | null = null, preview = '', busy = false, disposed = false, leaving = false;
const crop = new AvatarCrop(value => {clearPreview(); file = value; preview = URL.createObjectURL(value); render(); notice('头像已选好，点击“保存更改”后生效。');});

function form(): ProfileForm {return {username: username.value, password: password.value, confirmation: confirmation.value};}
function dirty(): boolean {return !!user && profileDirty(user, form(), !!file);}
function notice(text = '', error = false, success = false): void {
  const target = $('profile-notice'); target.textContent = text; target.hidden = !text;
  target.dataset.error = String(error); target.dataset.success = String(success);
}
function clearPreview(): void {if (preview) URL.revokeObjectURL(preview); preview = ''; file = null;}
function render(): void {
  fields.disabled = busy || !user; save.textContent = busy ? '正在保存…' : '保存更改';
  save.disabled = busy || !dirty(); $('avatar-reset').hidden = !file;
  avatar.setSource(preview || user?.avatar_url);
}
function login(): void {leaving = true; api.signOut(); location.replace('/play?next=%2Fprofile');}
function failure(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return error instanceof TypeError ? '连接失败，请检查网络后重试。' : error instanceof Error ? error.message : '保存失败，请稍后重试。';
}
async function load(): Promise<void> {
  if (busy) return; busy = true; render(); $('profile-retry').hidden = true;
  try {
    const restored = await api.restore(); if (disposed) return;
    if (!restored) {login(); return;}
    user = restored; username.value = user.username ?? ''; $<HTMLInputElement>('profile-email').value = user.email;
    notice();
  } catch (error) {
    if (!disposed) {notice(failure(error), true); $('profile-retry').hidden = false;}
  } finally {busy = false; if (!disposed) render();}
}

$('profile-form').addEventListener('input', () => {render();});
$('avatar-pick').addEventListener('click', () => {if (!busy && user) input.click();});
$('avatar-reset').addEventListener('click', () => {if (!busy) {clearPreview(); render(); notice();}});
input.addEventListener('change', () => {
  const selected = input.files?.[0]; input.value = '';
  if (!selected || busy || !user) return;
  void crop.open(selected).catch(error => {if (!disposed) notice(failure(error), true);});
});
$('profile-form').addEventListener('submit', event => {
  event.preventDefault(); if (!user || busy || !dirty()) return;
  let patch;
  try {patch = profilePatch(user, form());} catch (error) {notice(failure(error), true); return;}
  const updates = patch; busy = true; render(); notice();
  void (async () => {
    let avatarSaved = false;
    try {
      if (file) {
        const data = new FormData(); data.append('file', file);
        const updated = await api.request<User>('/users/me/avatar', {method: 'PATCH', body: data});
        if (disposed) return;
        user = updated; avatarSaved = true; clearPreview(); render();
      }
      if (Object.keys(updates).length) {
        const updated = await api.request<User>('/users/me', {method: 'PATCH', body: JSON.stringify(updates)});
        if (disposed) return; user = updated;
      }
      if (updates.password) {password.value = confirmation.value = ''; leaving = true; api.signOut(); location.replace('/play?password_changed=1'); return;}
      username.value = user!.username ?? ''; password.value = confirmation.value = '';
      notice('个人设置已保存。', false, true);
    } catch (error) {
      if (!disposed) notice(`${avatarSaved ? '头像已保存，其他更改未保存。' : ''}${failure(error)}`, true);
    } finally {busy = false; if (!disposed) render();}
  })();
});
for (const link of document.querySelectorAll<HTMLAnchorElement>('.profile-back, .brand')) link.addEventListener('click', event => {
  if (busy || (dirty() && !confirm('还有未保存的更改，确定离开？'))) event.preventDefault();
  else leaving = true;
});
$('profile-retry').addEventListener('click', () => {void load();});
window.addEventListener('beforeunload', event => {if (!leaving && dirty()) {event.preventDefault(); event.returnValue = '';}});
window.addEventListener('pagehide', () => {disposed = true; crop.dispose(); clearPreview(); avatar.dispose();});
window.addEventListener('pageshow', event => {if (event.persisted) location.reload();});
api.onExpired = login;
void load();

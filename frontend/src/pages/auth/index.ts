import {api} from '../../app/session.js';
import {loginReturnPath} from '../../app/navigation.js';
import {ApiError} from '../../shared/api/client.js';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const params = new URLSearchParams(location.search);
const registering = location.pathname.replace(/\/$/, '') === '/register';
const next = loginReturnPath(params.get('next')) ?? '/play';
const submit = $<HTMLButtonElement>('auth-submit');
const password = $<HTMLInputElement>('password');
let busy = true;

function notice(text = '', error = false): void {
  const target = $('notice'); target.textContent = text; target.hidden = !text;
  target.className = error ? 'notice error' : 'notice';
}
function failure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return '邮箱或密码不正确，请重试。';
    if (error.message === 'Email already exists') return '这个邮箱已注册，请直接登录。';
    return error.message;
  }
  return '连接失败，请检查网络或稍后重试。';
}
function render(): void {submit.disabled = busy; submit.textContent = busy ? '请稍候…' : registering ? '注册' : '登录';}

$('auth-title').textContent = registering ? '注册' : '登录';
document.title = `${registering ? '注册' : '登录'} · 雷霆之石`;
$('username-field').hidden = !registering;
$<HTMLInputElement>('username').required = registering;
password.autocomplete = registering ? 'new-password' : 'current-password';
const mode = $<HTMLAnchorElement>('auth-mode');
mode.textContent = registering ? '已有账号？登录' : '没有账号？注册';
mode.href = `${registering ? '/login' : '/register'}?next=${encodeURIComponent(next)}`;
if (params.get('password_changed') === '1') notice('密码已修改，请使用新密码重新登录。');
if (params.get('expired') === '1') notice('登录已失效，请重新登录。', true);

$('auth-form').addEventListener('submit', event => {
  event.preventDefault(); if (busy) return;
  busy = true; notice(); render();
  void (async () => {
    const email = $<HTMLInputElement>('email').value.trim();
    if (registering) await api.request('/auth/register', {method: 'POST', body: JSON.stringify({
      email, password: password.value, username: $<HTMLInputElement>('username').value.trim(),
    })});
    await api.login(email, password.value);
    password.value = ''; location.replace(next);
  })().catch(error => notice(failure(error), true)).finally(() => {busy = false; render();});
});

render();
void api.restore().then(user => {if (user) location.replace(next);})
  .catch(error => notice(failure(error), true)).finally(() => {busy = false; render();});

import {ApiClient} from '../shared/api/client.js';

let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> | null = null;
try {if (typeof sessionStorage !== 'undefined') storage = sessionStorage;} catch { /* Optional storage. */ }
export const api = new ApiClient(storage);


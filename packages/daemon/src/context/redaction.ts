// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
import { createHash } from 'node:crypto';
import path from 'node:path';

/** Never use a redactor's replacement text as a filesystem path. Changed paths get an opaque,
 * stable alias; distinct secrets that redact alike must still name distinct source files. */
export function sourcePath(raw:string,redact:(s:string)=>string):string {
  if(Buffer.byteLength(raw)>4096)throw new Error('Source path exceeds its size limit');
  const clean=redact(raw);
  if(clean===raw && !/[\u0000-\u001f\u007f\\]/.test(raw) && raw.split('/').every(p=>p&&p!=='.'&&p!=='..'&&Buffer.byteLength(p)<=240))return raw;
  const extension=path.extname(raw).toLowerCase();
  const suffix=/^\.[a-z0-9]{1,10}$/.test(extension)?extension:'.txt';
  return `one-connect-redacted/${createHash('sha256').update(raw).digest('hex')}/source${suffix}`;
}

/** JSON escaping must not hide a secret from the textual redactor. Keep existing line numbers. */
export function redactJsonStrings(text:string,redact:(s:string)=>string):string {
  return text.replace(/"(?:[^"\\]|\\.)*"/g,token=>{
    try {const value=JSON.parse(token) as string,clean=redact(value);return clean===value?token:JSON.stringify(clean);}
    catch{return token;}
  });
}

/** Unlike general event redaction, source metadata also redacts object keys. */
export function redactMetadata<T>(value:T,redact:(s:string)=>string):T {
  if(typeof value==='string')return redact(value) as T;
  if(Array.isArray(value))return value.map(v=>redactMetadata(v,redact)) as T;
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[redact(k),redactMetadata(v,redact)])) as T;
  return value;
}

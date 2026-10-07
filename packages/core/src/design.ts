// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
const color=z.string().regex(/^#[0-9a-fA-F]{6}$/,'Use a six-digit hex color');
export const DesignSystemSchema=z.object({
  name:z.string().min(1).max(100),
  direction:z.string().min(1).max(1200),
  colors:z.object({background:color,surface:color,text:color,muted:color,accent:color,accentText:color,border:color}),
  typography:z.enum(['system','editorial']).default('system'),
  spacing:z.enum(['compact','comfortable']).default('comfortable'),
  radius:z.number().int().min(0).max(24).default(8),
  motion:z.enum(['reduced','subtle']).default('subtle'),
  rules:z.string().max(2000).default(''),
});
export type DesignSystem=z.infer<typeof DesignSystemSchema>;
export interface DesignRevision {version:number;hash:string;system:DesignSystem;createdAt:string;}
export interface DesignSkill {id:string;name:string;description:string;license:string;source:string;version:string;}
export const DEFAULT_DESIGN:DesignSystem={name:'Connected clarity',direction:'A calm, readable workbench. Pearl surfaces, ink text, teal actions. Use hierarchy and shared tokens to make complex work understandable.',colors:{background:'#f3f6f7',surface:'#ffffff',text:'#18343b',muted:'#526870',accent:'#087e8b',accentText:'#ffffff',border:'#c9d6da'},typography:'system',spacing:'comfortable',radius:8,motion:'subtle',rules:'Use sentence-case labels, clear empty and error states, and visible keyboard focus. Tables describe comparisons; status never relies on color alone. Avoid generic promotional copy.'};
const luminance=(hex:string)=>{
  const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(x=>x<=0.04045?x/12.92:((x+0.055)/1.055)**2.4);
  return .2126*c[0]+.7152*c[1]+.0722*c[2];
};
export const contrast=(a:string,b:string)=>{const x=luminance(a),y=luminance(b);return (Math.max(x,y)+.05)/(Math.min(x,y)+.05);};
export function designChecks(s:DesignSystem) {
  return [['Body on surface',s.colors.text,s.colors.surface],['Body on canvas',s.colors.text,s.colors.background],['Secondary text',s.colors.muted,s.colors.surface],['Action label',s.colors.accentText,s.colors.accent]].map(([name,a,b])=>({name,ratio:contrast(a,b),passed:contrast(a,b)>=4.5}));
}
export function designCss(s:DesignSystem) {
  return ':root {\n'+Object.entries(s.colors).map(([k,v])=>`  --design-${k.replace(/[A-Z]/g,x=>'-'+x.toLowerCase())}: ${v};`).join('\n')+`\n  --design-radius: ${s.radius}px;\n  --design-space: ${s.spacing==='compact'?4:8}px;\n  --design-font: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;\n}\n`;
}
export function designMarkdown(r:DesignRevision) {
  const s=r.system;
  return `# ${s.name}\n\nDesign contract v${r.version} · SHA-256 ${r.hash}\n\n${s.direction}\n\n## Tokens\n\n`+Object.entries(s.colors).map(([k,v])=>`- ${k}: \`${v}\` (CSS: --design-${k.replace(/[A-Z]/g,x=>'-'+x.toLowerCase())})`).join('\n')+`\n\n## Layout and components\n\nTypography: ${s.typography==='editorial'?'serif display headings, system sans body':'system sans, monospace only for code'}. Spacing: ${s.spacing==='compact'?'4':'8'} px base. Radius: ${s.radius} px. Motion: ${s.motion}; honor reduced motion.\n\nUse semantic controls, readable contrast, visible focus, keyboard operation, and complete loading/empty/error states. Mobile targets: 44 px. Keep content readable at 200% zoom.\n\n${s.rules}\n\n## Enforcement\n\nRead this exact revision before UI work. Use the supplied tokens. Any visual exception needs a human design decision and a recorded rationale. Include the design revision and viewport/check evidence in handoffs. Skill references guide execution; this project contract controls its visual identity.\n`;
}

// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The editable starter library (common product components with variants, states, props and slots),
// five multi-screen starters with working prototype flows, and the deterministic proposal behind
// "Describe an idea": a visual direction, foundations, components and first screens from one prompt.
import { DEFAULT_CONTENT, DEFAULT_SETTINGS, TONES, TYPEFACES, generateFoundations, resolveToken, type DesignTone, type DesignTypeface } from './designFoundations.ts';
import { newDesignNode, parseDesignDocument, DESIGN_DOCUMENT_SCHEMA } from './designDocument.ts';
import type {
  DesignComponent, DesignContentState, DesignDocument, DesignInteraction, DesignLayout, DesignNode, DesignNodeKind, DesignNodeProps, DesignOverride,
  DesignResponsive, DesignScreen,
} from './designDocumentTypes.ts';

export const DESIGN_STARTERS = ['dashboard', 'landing', 'onboarding', 'commerce', 'settings'] as const;
export type DesignStarter = (typeof DESIGN_STARTERS)[number];
export const STARTER_INFO: Record<DesignStarter, { label: string; summary: string; screens: string[] }> = {
  dashboard: { label: 'Dashboard', summary: 'Metrics, activity and a project list with a create dialog.', screens: ['Overview', 'Projects', 'Project details', 'New project'] },
  landing: { label: 'Landing page', summary: 'A hero, features, pricing and a sign-up flow.', screens: ['Home', 'Sign up', 'Welcome aboard'] },
  onboarding: { label: 'Onboarding', summary: 'A short guided setup with progress and validation.', screens: ['Welcome', 'Your profile', 'Preferences', 'All set'] },
  commerce: { label: 'Commerce', summary: 'Browse products, view details and review a cart.', screens: ['Shop', 'Product', 'Cart'] },
  settings: { label: 'Settings', summary: 'Profile, notifications and billing with a confirm dialog.', screens: ['Profile', 'Notifications', 'Billing', 'Delete account'] },
};

// ---- a small builder ------------------------------------------------------------------------------

export interface LayerSpec {
  kind: DesignNodeKind;
  name?: string;
  id?: string;
  props?: DesignNodeProps;
  layout?: DesignLayout;
  responsive?: { phone?: DesignResponsive; tablet?: DesignResponsive };
  children?: LayerSpec[];
}
const L = (kind: DesignNodeKind, name?: string, props?: DesignNodeProps, layout?: DesignLayout, children?: LayerSpec[], extra: Partial<LayerSpec> = {}): LayerSpec => ({ kind, name, props, layout, children, ...extra });
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'layer';

export class DesignBuilder {
  readonly nodes: Record<string, DesignNode> = {};
  readonly taken: (id: string) => boolean;
  constructor(taken: (id: string) => boolean = () => false) { this.taken = taken; }
  unique(base: string): string {
    const clean = /^[A-Za-z]/.test(base) ? base.slice(0, 90) : `l-${base}`.slice(0, 90);
    let key = clean, n = 2;
    while (this.nodes[key] || this.taken(key)) key = `${clean}-${n++}`;
    return key;
  }
  /** Create a layer tree; returns the root id. */
  layer(prefix: string, s: LayerSpec): string {
    const key = this.unique(s.id ?? `${prefix}-${slug(s.name ?? s.kind)}`);
    const base = newDesignNode(key, s.kind, s.name);
    const node: DesignNode = { ...base, props: { ...base.props, ...s.props }, layout: { ...base.layout, ...s.layout }, ...(s.responsive ? { responsive: s.responsive } : {}) };
    this.nodes[key] = node;
    node.children = (s.children ?? []).map(c => this.layer(prefix, c));
    return key;
  }
  /** Layers of one tree, root first, for insert-tree operations. */
  tree(rootId: string): DesignNode[] {
    const out: DesignNode[] = [], stack = [rootId];
    while (stack.length) { const k = stack.shift()!; out.push(this.nodes[k]); stack.push(...this.nodes[k].children); }
    return out;
  }
}

// ---- the starter component library --------------------------------------------------------------

export interface LibraryComponent { component: DesignComponent; nodes: DesignNode[] }
type Def = Omit<DesignComponent, 'root' | 'variants'> & { variants?: DesignComponent['variants']; tree: LayerSpec };

const btn = (id: string, text: string, props: DesignNodeProps = {}) => L('button', text, { text, ...props }, {}, undefined, { id });
const field = (id: string, label: string, props: DesignNodeProps = {}) => L('input', label, { label, ...props }, {}, undefined, { id });
const title = (id: string, text: string, size = 'text-lg') => L('text', 'Heading', { text, fontSize: size, fontWeight: 'weight-heading', font: 'font-heading', level: 2 }, {}, undefined, { id });
const body = (id: string, text: string) => L('text', 'Description', { text, color: 'text-muted' }, {}, undefined, { id });

const DEFS: Def[] = [
  {
    id: 'button', name: 'Button', category: 'actions', description: 'Starts an action. One primary button per view.',
    usage: 'Use a verb that says what happens (“Save changes”, not “OK”). Primary for the main action, secondary for alternatives, ghost for low-emphasis actions, danger for destructive ones.',
    accessibility: 'Uses a real button. Visible focus ring. At least 44px tall. Loading keeps its width and announces progress; disabled buttons explain why nearby.',
    tree: btn('c-button', 'Continue', { background: 'accent', color: 'on-accent', radius: 'radius-md', fontWeight: 'weight-medium' }),
    variants: {
      primary: {},
      secondary: { 'c-button': { background: 'surface', color: 'text', border: true, borderColor: 'border-strong' } },
      ghost: { 'c-button': { background: 'transparent', color: 'accent' } },
      danger: { 'c-button': { background: 'danger', color: 'on-danger' } },
    },
    states: { disabled: { 'c-button': { disabled: true } }, loading: { 'c-button': { text: 'Working…', disabled: true, icon: 'sparkle' } } },
    props: [{ id: 'label', label: 'Label', node: 'c-button', field: 'text' }],
  },
  {
    id: 'text-field', name: 'Text field', category: 'forms', description: 'A labelled single-line input with help and error text.',
    usage: 'Always show a visible label. Put format hints in help text, not the placeholder.',
    accessibility: 'Label is programmatically tied to the input; errors are announced and linked with aria-describedby.',
    tree: field('c-field', 'Email address', { placeholder: 'name@example.com', inputType: 'email', helperText: 'We’ll only use this to send receipts.' }),
    variants: { default: {} },
    states: { error: { 'c-field': { errorText: 'Enter an email address like name@example.com.' } }, disabled: { 'c-field': { disabled: true } } },
    props: [{ id: 'label', label: 'Label', node: 'c-field', field: 'label' }, { id: 'placeholder', label: 'Placeholder', node: 'c-field', field: 'placeholder' }, { id: 'help', label: 'Help text', node: 'c-field', field: 'helperText' }],
  },
  {
    id: 'text-area', name: 'Text area', category: 'forms', description: 'Multi-line input for longer answers.', accessibility: 'Visible label; resizes vertically; character limits are announced.',
    tree: L('textarea', 'Message', { label: 'Message', placeholder: 'Share any details that will help' }, {}, undefined, { id: 'c-textarea' }),
    props: [{ id: 'label', label: 'Label', node: 'c-textarea', field: 'label' }],
  },
  {
    id: 'dropdown', name: 'Dropdown', category: 'forms', description: 'Choose one option from a short list.', accessibility: 'Native select for full keyboard and screen-reader support.',
    tree: L('select', 'Role', { label: 'Role', options: ['Owner', 'Editor', 'Viewer'], value: 'Editor' }, {}, undefined, { id: 'c-select' }),
    props: [{ id: 'label', label: 'Label', node: 'c-select', field: 'label' }],
  },
  {
    id: 'checkbox', name: 'Checkbox', category: 'forms', description: 'Turn one option on or off within a form.', accessibility: 'Whole label is clickable; state is announced.',
    tree: L('checkbox', 'Checkbox', { label: 'Send me product updates' }, {}, undefined, { id: 'c-checkbox' }),
    props: [{ id: 'label', label: 'Label', node: 'c-checkbox', field: 'label' }],
  },
  {
    id: 'switch', name: 'Switch', category: 'forms', description: 'A setting that takes effect immediately.', accessibility: 'role="switch" with aria-checked; label describes the setting, not the state.',
    tree: L('switch', 'Switch', { label: 'Email notifications', checked: true }, {}, undefined, { id: 'c-switch' }),
    props: [{ id: 'label', label: 'Label', node: 'c-switch', field: 'label' }],
  },
  {
    id: 'radio-group', name: 'Radio group', category: 'forms', description: 'Choose exactly one of a few visible options.', accessibility: 'Fieldset with a legend; arrow keys move between options.',
    tree: L('radio', 'Plan', { label: 'Plan', options: ['Starter', 'Team', 'Enterprise'], selected: 1 }, {}, undefined, { id: 'c-radio' }),
    props: [{ id: 'label', label: 'Label', node: 'c-radio', field: 'label' }],
  },
  {
    id: 'top-bar', name: 'Top bar', category: 'navigation', description: 'Brand, primary navigation and the main action.',
    usage: 'Keep it to five or fewer destinations. On phones the navigation collapses below the brand.',
    accessibility: 'A nav landmark with an accessible name; the current page is marked with aria-current.',
    tree: L('frame', 'Top bar', { background: 'surface', borderColor: 'border' }, { direction: 'row', align: 'center', justify: 'between', gap: 'space-5', paddingX: 'space-6', paddingY: 'space-3', wrap: true }, [
      L('text', 'Brand', { text: 'Northwind', fontSize: 'text-lg', fontWeight: 'weight-bold' }, { width: 'hug' }, undefined, { id: 'c-topbar-brand' }),
      L('navigation', 'Navigation', { label: 'Main', options: ['Overview', 'Projects', 'Reports'], selected: 0 }, { width: 'hug' }, undefined, { id: 'c-topbar-nav' }),
      L('slot', 'Actions', {}, { direction: 'row', gap: 'space-2', width: 'hug' }, [btn('c-topbar-action', 'New project', { background: 'accent', color: 'on-accent', radius: 'radius-md', icon: 'plus' })], { id: 'c-topbar-actions' }),
    ], { id: 'c-topbar', responsive: { phone: { paddingX: 'space-4', gap: 'space-3' } } }),
    slots: ['c-topbar-actions'],
    props: [{ id: 'brand', label: 'Brand name', node: 'c-topbar-brand', field: 'text' }],
  },
  {
    id: 'sidebar', name: 'Sidebar', category: 'navigation', description: 'Vertical navigation for apps with several sections.', accessibility: 'A nav landmark; collapses to a top list on phones.',
    tree: L('frame', 'Sidebar', { background: 'surface' }, { direction: 'column', gap: 'space-5', padding: 'space-5', width: 240 }, [
      L('text', 'Brand', { text: 'Northwind', fontSize: 'text-lg', fontWeight: 'weight-bold' }, {}, undefined, { id: 'c-sidebar-brand' }),
      L('navigation', 'Navigation', { label: 'Sections', options: ['Profile', 'Notifications', 'Billing'], selected: 0 }, { direction: 'column' }, undefined, { id: 'c-sidebar-nav' }),
    ], { id: 'c-sidebar', responsive: { phone: { width: 'fill' }, tablet: { width: 200 } } }),
    props: [{ id: 'brand', label: 'Brand name', node: 'c-sidebar-brand', field: 'text' }],
  },
  {
    id: 'tabs', name: 'Tabs', category: 'navigation', description: 'Switch between related views without leaving the page.', accessibility: 'Arrow keys, Home and End move between tabs; only the selected tab is in the tab order.',
    tree: L('tabs', 'Tabs', { label: 'Sections', options: ['Overview', 'Activity', 'Settings'], selected: 0 }, {}, [
      L('slot', 'Overview panel', {}, {}, [body('c-tabs-p1', 'Overview content goes here.')], { id: 'c-tabs-one' }),
      L('slot', 'Activity panel', {}, {}, [body('c-tabs-p2', 'Recent activity appears here.')], { id: 'c-tabs-two' }),
      L('slot', 'Settings panel', {}, {}, [body('c-tabs-p3', 'Settings for this view.')], { id: 'c-tabs-three' }),
    ], { id: 'c-tabs' }),
    slots: ['c-tabs-one', 'c-tabs-two', 'c-tabs-three'],
  },
  {
    id: 'pagination', name: 'Pagination', category: 'navigation', description: 'Move through long lists a page at a time.', accessibility: 'A nav landmark; the current page has aria-current.',
    tree: L('pagination', 'Pagination', { label: 'Pages', values: [8], selected: 0 }, {}, undefined, { id: 'c-pagination' }),
  },
  {
    id: 'dialog', name: 'Dialog', category: 'overlays', description: 'Focused task or confirmation over the current screen.',
    usage: 'Keep dialogs short. Title says what’s being decided; the primary action repeats the verb.',
    accessibility: 'Modal dialog with a labelled heading. Focus moves inside, Escape closes, focus returns to the trigger.',
    tree: L('dialog', 'Dialog', {}, { width: 480 }, [
      title('c-dialog-title', 'Create a project'),
      body('c-dialog-body', 'Give your project a name. You can change it later.'),
      L('slot', 'Content', {}, {}, [], { id: 'c-dialog-content' }),
      L('frame', 'Actions', {}, { direction: 'row', gap: 'space-3', justify: 'end', wrap: true }, [
        btn('c-dialog-cancel', 'Cancel', { background: 'surface', color: 'text', border: true, borderColor: 'border-strong', radius: 'radius-md' }),
        btn('c-dialog-confirm', 'Create project', { background: 'accent', color: 'on-accent', radius: 'radius-md' }),
      ], { id: 'c-dialog-actions' }),
    ], { id: 'c-dialog', responsive: { phone: { width: 'fill' } } }),
    slots: ['c-dialog-content'],
    props: [{ id: 'title', label: 'Title', node: 'c-dialog-title', field: 'text' }, { id: 'body', label: 'Description', node: 'c-dialog-body', field: 'text' }, { id: 'confirm', label: 'Confirm label', node: 'c-dialog-confirm', field: 'text' }],
    variants: { default: {}, destructive: { 'c-dialog-confirm': { background: 'danger', color: 'on-danger', text: 'Delete' } } },
  },
  {
    id: 'drawer', name: 'Drawer', category: 'overlays', description: 'Side panel for details or filters without leaving the page.', accessibility: 'Modal with a heading and close button; Escape closes.',
    tree: L('drawer', 'Drawer', {}, {}, [title('c-drawer-title', 'Filters'), L('slot', 'Content', {}, {}, [body('c-drawer-body', 'Choose what to show.')], { id: 'c-drawer-content' })], { id: 'c-drawer' }),
    slots: ['c-drawer-content'],
    props: [{ id: 'title', label: 'Title', node: 'c-drawer-title', field: 'text' }],
  },
  {
    id: 'menu', name: 'Menu', category: 'overlays', description: 'A short list of actions behind one button.', accessibility: 'Menu button pattern: arrow keys move, Escape closes and returns focus.',
    tree: L('menu', 'Menu', { text: 'Actions', label: 'Project actions', options: ['Rename', 'Duplicate', 'Archive'] }, {}, undefined, { id: 'c-menu' }),
    props: [{ id: 'label', label: 'Button label', node: 'c-menu', field: 'text' }],
  },
  {
    id: 'tooltip', name: 'Tooltip', category: 'overlays', description: 'A short hint on hover or focus. Never the only place for essential information.', accessibility: 'Appears on focus as well as hover; linked with aria-describedby.',
    tree: L('tooltip', 'Tooltip', { text: 'Shown on hover and keyboard focus' }, {}, [L('icon', 'Info icon', { icon: 'info', label: 'More information', color: 'text-muted' }, {}, undefined, { id: 'c-tooltip-icon' })], { id: 'c-tooltip' }),
    props: [{ id: 'hint', label: 'Hint', node: 'c-tooltip', field: 'text' }],
  },
  {
    id: 'notification', name: 'Notification', category: 'feedback', description: 'Tells people what happened and what to do next.',
    usage: 'Inline next to the related content when possible. Success confirms what changed; errors say how to fix it.',
    accessibility: 'Announced through a polite live region (errors: assertive). Status is shown with an icon and words, never color alone.',
    tree: L('notification', 'Notification', { text: 'Your changes were saved.', label: 'Saved', tone: 'success' }, {}, undefined, { id: 'c-notice' }),
    variants: { info: { 'c-notice': { tone: 'info', label: 'Heads up' } }, success: {}, warning: { 'c-notice': { tone: 'warning', label: 'Check this' } }, danger: { 'c-notice': { tone: 'danger', label: 'Something went wrong' } } },
    props: [{ id: 'title', label: 'Title', node: 'c-notice', field: 'label' }, { id: 'message', label: 'Message', node: 'c-notice', field: 'text' }],
  },
  {
    id: 'progress', name: 'Progress', category: 'feedback', description: 'Shows how far along a task is.', accessibility: 'progressbar role with a label and value.',
    tree: L('progress', 'Progress', { label: 'Setup progress', values: [40] }, {}, undefined, { id: 'c-progress' }),
    props: [{ id: 'label', label: 'Label', node: 'c-progress', field: 'label' }],
  },
  {
    id: 'card', name: 'Card', category: 'content', description: 'Groups related content with one clear heading.', accessibility: 'Heading level fits the page outline; a whole-card link has one clear target.',
    tree: L('card', 'Card', {}, {}, [title('c-card-title', 'Card title', 'text-md'), body('c-card-body', 'A short description of what this card is about.'), L('slot', 'Content', {}, {}, [], { id: 'c-card-content' })], { id: 'c-card' }),
    slots: ['c-card-content'],
    props: [{ id: 'title', label: 'Title', node: 'c-card-title', field: 'text' }, { id: 'body', label: 'Description', node: 'c-card-body', field: 'text' }],
    variants: { default: {}, highlighted: { 'c-card': { background: 'accent-subtle', borderColor: 'accent' }, 'c-card-body': { color: 'text' } } },
  },
  {
    id: 'metric', name: 'Metric card', category: 'content', description: 'One number that matters, with context.', accessibility: 'The label is read before the number; trends use words as well as color.',
    tree: L('card', 'Metric card', {}, { gap: 'space-2' }, [
      L('text', 'Label', { text: 'Active projects', color: 'text-muted', fontSize: 'text-sm' }, {}, undefined, { id: 'c-metric-label' }),
      L('text', 'Value', { text: '24', fontSize: 'text-3xl', fontWeight: 'weight-bold', lineHeight: 'leading-tight' }, {}, undefined, { id: 'c-metric-value' }),
      L('badge', 'Trend', { text: '+12% this month', tone: 'success' }, {}, undefined, { id: 'c-metric-trend' }),
    ], { id: 'c-metric' }),
    props: [{ id: 'label', label: 'Label', node: 'c-metric-label', field: 'text' }, { id: 'value', label: 'Value', node: 'c-metric-value', field: 'text' }, { id: 'trend', label: 'Trend', node: 'c-metric-trend', field: 'text' }],
  },
  {
    id: 'user-row', name: 'Person', category: 'content', description: 'Avatar, name and role.', accessibility: 'Avatar is decorative when the name is shown.',
    tree: L('frame', 'Person', {}, { direction: 'row', align: 'center', gap: 'space-3', width: 'hug' }, [
      L('avatar', 'Avatar', { label: 'Priya Shah' }, {}, undefined, { id: 'c-person-avatar' }),
      L('frame', 'Text', {}, { gap: 0, width: 'hug' }, [L('text', 'Name', { text: 'Priya Shah', fontWeight: 'weight-medium' }, {}, undefined, { id: 'c-person-name' }), L('text', 'Role', { text: 'Product lead', color: 'text-muted', fontSize: 'text-sm' }, {}, undefined, { id: 'c-person-role' })], { id: 'c-person-text' }),
    ], { id: 'c-person' }),
    props: [{ id: 'name', label: 'Name', node: 'c-person-name', field: 'text' }, { id: 'role', label: 'Role', node: 'c-person-role', field: 'text' }],
  },
  {
    id: 'data-table', name: 'Table', category: 'data', description: 'Compare items across the same columns.', usage: 'Left-align text, right-align numbers; keep columns few on phones.',
    accessibility: 'Real table with a caption and column headers; scrolls horizontally inside its own region on narrow screens.',
    tree: L('table', 'Table', { label: 'Recent projects', rows: [['Project', 'Status', 'Owner', 'Updated'], ['Atlas', 'Active', 'Priya', 'Today'], ['Luna', 'In review', 'Sam', 'Yesterday'], ['Nova', 'Paused', 'Lee', 'Oct 2']] }, {}, undefined, { id: 'c-table' }),
  },
  {
    id: 'bar-chart', name: 'Bar chart', category: 'data', description: 'Compare a few values side by side.', accessibility: 'Has a text alternative listing the values; never relies on color alone.',
    tree: L('chart', 'Bar chart', { label: 'Weekly activity', chart: 'bar', values: [32, 48, 41, 66, 58, 72, 61], options: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] }, {}, undefined, { id: 'c-chart' }),
    variants: { bar: {}, line: { 'c-chart': { chart: 'line' } }, donut: { 'c-chart': { chart: 'donut' } } },
  },
  {
    id: 'empty-state', name: 'Empty state', category: 'states', description: 'Explains what will appear here and the first step.', accessibility: 'Heading and action are reachable; illustration is decorative.',
    tree: L('frame', 'Empty state', { textAlign: 'center' }, { align: 'center', gap: 'space-3', padding: 'space-7' }, [
      L('icon', 'Icon', { icon: 'folder', label: 'No items', color: 'text-muted', fontSize: 32 }, {}, undefined, { id: 'c-empty-icon' }),
      title('c-empty-title', 'No projects yet', 'text-lg'),
      body('c-empty-body', 'Projects you create will appear here.'),
      btn('c-empty-action', 'Create a project', { background: 'accent', color: 'on-accent', radius: 'radius-md' }),
    ], { id: 'c-empty' }),
    props: [{ id: 'title', label: 'Title', node: 'c-empty-title', field: 'text' }, { id: 'body', label: 'Message', node: 'c-empty-body', field: 'text' }, { id: 'action', label: 'Action', node: 'c-empty-action', field: 'text' }],
  },
  {
    id: 'loading-state', name: 'Loading state', category: 'states', description: 'Keeps the layout steady while content loads.', accessibility: 'aria-busy on the region; a spinner has a text label.',
    tree: L('frame', 'Loading state', {}, { gap: 'space-3', padding: 'space-5' }, [L('spinner', 'Spinner', { label: 'Loading projects' }, {}, undefined, { id: 'c-loading-spinner' }), L('skeleton', 'Placeholder', { values: [3] }, {}, undefined, { id: 'c-loading-lines' })], { id: 'c-loading' }),
  },
  {
    id: 'error-state', name: 'Error state', category: 'states', description: 'Says what failed and how to recover without losing work.', accessibility: 'role="alert" for new errors; the retry button is focusable.',
    tree: L('frame', 'Error state', { textAlign: 'center' }, { align: 'center', gap: 'space-3', padding: 'space-7' }, [
      L('icon', 'Icon', { icon: 'warning', label: 'Error', color: 'danger', fontSize: 32 }, {}, undefined, { id: 'c-error-icon' }),
      title('c-error-title', 'We couldn’t load your projects', 'text-lg'),
      body('c-error-body', 'Check your connection. Your filters are kept.'),
      btn('c-error-action', 'Try again', { background: 'surface', color: 'text', border: true, borderColor: 'border-strong', radius: 'radius-md' }),
    ], { id: 'c-error' }),
    props: [{ id: 'title', label: 'Title', node: 'c-error-title', field: 'text' }, { id: 'body', label: 'Message', node: 'c-error-body', field: 'text' }],
  },
];

export const LIBRARY_CATEGORIES: Record<string, string> = { actions: 'Actions', forms: 'Forms', navigation: 'Navigation', overlays: 'Overlays', feedback: 'Feedback', content: 'Content', data: 'Data', states: 'States' };

/** The starter library, freshly built. Component and layer ids are stable so copies can be updated. */
export function starterLibrary(): LibraryComponent[] {
  return DEFS.map(def => {
    const b = new DesignBuilder();
    const root = b.layer(def.id, def.tree);
    const { tree: _tree, ...rest } = def;
    return { component: { variants: {}, ...rest, root }, nodes: b.tree(root) };
  });
}
export const STARTER_COMPONENT_IDS = DEFS.map(d => d.id);

// ---- starters -----------------------------------------------------------------------------------

type InstanceSpec = { component: string; name?: string; variant?: string; state?: string; set?: Record<string, string>; overrides?: Record<string, DesignOverride>; layout?: DesignLayout; fill?: Record<string, LayerSpec[]> };
interface ScreenSpec { id: string; name: string; kind?: DesignScreen['kind']; states?: DesignContentState[]; root: LayerSpec; instances?: never }

/** Compose screens that mix plain layers and library instances. */
class Composer extends DesignBuilder {
  readonly components: Record<string, DesignComponent> = {};
  readonly interactions: DesignInteraction[] = [];
  readonly screens: DesignScreen[] = [];
  private library = new Map(starterLibrary().map(c => [c.component.id, c]));
  use(id: string): DesignComponent {
    if (!this.components[id]) {
      const lib = this.library.get(id)!;
      this.components[id] = lib.component;
      for (const n of lib.nodes) this.nodes[n.id] = n;
    }
    return this.components[id];
  }
  /** An instance layer with component props set by their ids. */
  instance(prefix: string, s: InstanceSpec): string {
    const c = this.use(s.component);
    const overrides: Record<string, DesignOverride> = { ...s.overrides };
    for (const [prop, val] of Object.entries(s.set ?? {})) {
      const p = c.props?.find(x => x.id === prop);
      if (p) overrides[p.node] = { ...overrides[p.node], [p.field]: p.field === 'hidden' ? val === 'true' : val };
    }
    const key = this.unique(`${prefix}-${slug(s.name ?? c.name)}`);
    const children: string[] = [];
    for (const [slot, specs] of Object.entries(s.fill ?? {})) for (const spec of specs) {
      const child = this.layer(prefix, spec);
      this.nodes[child].props.slot = slot;
      children.push(child);
    }
    this.nodes[key] = { id: key, name: s.name ?? c.name, kind: 'instance', children, layout: { width: 'fill', ...s.layout }, props: { componentId: c.id, ...(s.variant ? { variant: s.variant } : {}), ...(s.state ? { componentState: s.state } : {}), ...(Object.keys(overrides).length ? { overrides } : {}) } };
    return key;
  }
  screen(s: ScreenSpec, build: (root: string) => void = () => {}): string {
    const root = this.layer(s.id, s.root);
    this.screens.push({ id: s.id, name: s.name, root, states: s.states ?? ['success', 'empty', 'loading', 'error'], ...(s.kind && s.kind !== 'page' ? { kind: s.kind } : {}) });
    build(root);
    return root;
  }
  append(parent: string, child: string) { this.nodes[parent].children.push(child); }
  on(source: string, action: DesignInteraction['action'], o: Partial<DesignInteraction> = {}) {
    this.interactions.push({ id: this.uniqueInteraction(`go-${source}`), source, event: 'click', action, transition: action === 'navigate' ? 'fade' : action === 'open-overlay' ? 'scale' : 'none', ...o });
  }
  private uniqueInteraction(base: string) { let k = base.slice(0, 90), n = 2; while (this.interactions.some(i => i.id === k)) k = `${base.slice(0, 85)}-${n++}`; return k; }
}

const page = (name: string, children: LayerSpec[], o: { gap?: string | number } = {}): LayerSpec => L('frame', name, { background: 'canvas', color: 'text', font: 'font-body' }, { direction: 'column', gap: o.gap ?? 'space-6', padding: 0, width: 'fill', minHeight: 720 }, children);
const section = (name: string, children: LayerSpec[], layout: DesignLayout = {}, props: DesignNodeProps = {}): LayerSpec => L('frame', name, props, { direction: 'column', gap: 'space-5', paddingX: 'space-7', paddingY: 'space-6', width: 'fill', maxWidth: 1200, ...layout }, children, { responsive: { phone: { paddingX: 'space-4', paddingY: 'space-5' } } });
const SMALLER: Record<string, string> = { 'text-4xl': 'text-2xl', 'text-3xl': 'text-2xl', 'text-2xl': 'text-xl', 'text-xl': 'text-lg' };
const heading = (text: string, size = 'text-3xl', level: 1 | 2 | 3 = 1): LayerSpec => L('text', 'Heading', { text, fontSize: size, fontWeight: 'weight-heading', font: 'font-heading', lineHeight: 'leading-tight', letterSpacing: 'tracking-tight', level }, {}, undefined, SMALLER[size] ? { responsive: { phone: { fontSize: SMALLER[size] } } } : {});
const para = (text: string, muted = true): LayerSpec => L('text', 'Text', { text, ...(muted ? { color: 'text-muted' } : {}) }, { maxWidth: 680 });
const row = (name: string, children: LayerSpec[], layout: DesignLayout = {}): LayerSpec => L('frame', name, {}, { direction: 'row', gap: 'space-3', align: 'center', wrap: true, ...layout }, children);
const grid = (name: string, columns: number, children: LayerSpec[]): LayerSpec => L('frame', name, {}, { direction: 'grid', columns, gap: 'space-5' }, children, { responsive: { phone: { columns: 1 }, tablet: { columns: Math.min(2, columns) } } });
const primary = (text: string, id?: string): LayerSpec => L('button', text, { text, background: 'accent', color: 'on-accent', radius: 'radius-md', fontWeight: 'weight-medium' }, {}, undefined, id ? { id } : {});
const secondary = (text: string, id?: string): LayerSpec => L('button', text, { text, background: 'surface', color: 'text', border: true, borderColor: 'border-strong', radius: 'radius-md' }, {}, undefined, id ? { id } : {});

function dashboard(c: Composer, name: string) {
  const nav = (screen: string, selected: number) => c.instance(screen, { component: 'top-bar', name: 'Top bar', set: { brand: name }, overrides: { 'c-topbar-nav': { selected } } });
  const ids: Record<string, string> = {};
  c.screen({ id: 'overview', name: 'Overview', root: page('Overview', []) }, root => {
    const bar = nav('overview', 0); c.append(root, bar); ids.overviewBar = bar;
    const body = c.layer('overview', section('Content', [heading('Your work, at a glance'), para('Track progress across projects and spot what needs attention.')]));
    c.append(root, body);
    const metrics = c.layer('overview', grid('Highlights', 3, []));
    for (const [label, value, trend] of [['Active projects', '24', '+3 this week'], ['In review', '8', '2 due today'], ['Completed', '16', '+12% this month']]) c.append(metrics, c.instance('overview', { component: 'metric', name: label, set: { label, value, trend } }));
    c.append(body, metrics);
    const charts = c.layer('overview', grid('Activity', 2, []));
    c.append(charts, c.instance('overview', { component: 'card', name: 'Activity card', set: { title: 'Weekly activity', body: 'Tasks completed across all projects.' }, fill: { 'c-card-content': [L('chart', 'Activity chart', { label: 'Tasks completed per day', chart: 'bar', values: [12, 19, 15, 24, 22, 9, 6], options: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] })] } }));
    c.append(charts, c.instance('overview', { component: 'card', name: 'Team card', set: { title: 'Team', body: 'Who is working on what this week.' }, fill: { 'c-card-content': [L('list', 'Team list', { label: 'Team members', options: ['Priya Shah — Atlas', 'Sam Lee — Luna', 'Ari Cohen — Nova'] })] } }));
    c.append(body, charts);
    const viewAll = c.layer('overview', secondary('View all projects', 'overview-view-all'));
    c.append(body, viewAll); ids.viewAll = viewAll;
  });
  c.screen({ id: 'projects', name: 'Projects', root: page('Projects', []) }, root => {
    const bar = nav('projects', 1); c.append(root, bar); ids.projectsBar = bar;
    const body = c.layer('projects', section('Content', [heading('Projects'), row('Filters', [L('input', 'Search', { label: 'Search projects', placeholder: 'Search by name', inputType: 'search', icon: 'search' }, { width: 320 }), L('select', 'Status filter', { label: 'Status', options: ['All', 'Active', 'In review', 'Paused'], value: 'All' }, { width: 200 })], { align: 'end' })]));
    c.append(root, body);
    c.append(body, c.instance('projects', { component: 'data-table', name: 'Projects table' }));
    c.append(body, c.instance('projects', { component: 'pagination', name: 'Pages', layout: { width: 'hug' } }));
    const open = c.layer('projects', secondary('Open Atlas', 'projects-open'));
    c.append(body, open); ids.openProject = open;
  });
  c.screen({ id: 'project', name: 'Project details', root: page('Project details', []) }, root => {
    const bar = nav('project', 1); c.append(root, bar); ids.projectBar = bar;
    const back = c.layer('project', L('link', 'Back link', { text: '← All projects', color: 'accent' }));
    const body = c.layer('project', section('Content', [heading('Atlas', 'text-3xl'), para('Redesigning the customer portal for faster self-service.')]));
    c.nodes[body].children.unshift(back); ids.back = back;
    c.append(root, body);
    c.append(body, c.instance('project', { component: 'notification', name: 'Review notice', variant: 'info', set: { title: 'Review due Friday', message: 'Two screens are waiting for feedback.' } }));
    c.append(body, c.instance('project', { component: 'tabs', name: 'Project tabs', fill: {
      'c-tabs-one': [para('Goals: launch the new portal to 20% of customers by November.', false), L('progress', 'Progress', { label: 'Milestones complete', values: [65] })],
      'c-tabs-two': [L('list', 'Activity', { label: 'Recent activity', options: ['Priya approved the dashboard', 'Sam uploaded new screenshots', 'Lee commented on billing'] })],
      'c-tabs-three': [L('switch', 'Notifications', { label: 'Notify me about changes', checked: true })],
    } }));
  });
  c.screen({ id: 'new-project', name: 'New project', kind: 'dialog', states: ['success', 'error'], root: L('frame', 'New project', { color: 'text', font: 'font-body' }, { padding: 0, width: 'fill' }) }, root => {
    const dialog = c.instance('new-project', { component: 'dialog', name: 'New project dialog', set: { title: 'Create a project', body: 'Give your project a name. You can change it later.', confirm: 'Create project' }, fill: { 'c-dialog-content': [L('input', 'Project name', { label: 'Project name', placeholder: 'Customer portal', required: true }, {}, undefined, { id: 'new-project-name' })] } });
    c.append(root, dialog); ids.dialog = dialog;
  });
  c.on('c-topbar-action', 'open-overlay', { target: 'new-project' });
  c.on('c-dialog-cancel', 'close-overlay');
  c.interactions.push({ id: 'validate-new-project', source: 'c-dialog-confirm', event: 'click', action: 'validate', transition: 'none' }, { id: 'close-new-project', source: 'c-dialog-confirm', event: 'click', action: 'close-overlay', transition: 'none' });
  for (const [option, target] of [['Overview', 'overview'], ['Projects', 'projects'], ['Reports', 'projects']] as const) c.interactions.push({ id: `nav-${slug(option)}`, source: 'c-topbar-nav', event: 'change', action: 'navigate', target, match: option, transition: 'fade' });
  c.on(ids.viewAll, 'navigate', { target: 'projects' });
  c.on(ids.openProject, 'navigate', { target: 'project' });
  c.on(ids.back, 'back');
}

function landing(c: Composer, name: string) {
  const ids: Record<string, string> = {};
  c.screen({ id: 'home', name: 'Home', states: ['success'], root: page('Home', [], { gap: 0 }) }, root => {
    c.append(root, c.instance('home', { component: 'top-bar', name: 'Top bar', set: { brand: name }, overrides: { 'c-topbar-nav': { label: 'Site', options: ['Features', 'Pricing', 'Customers'] }, 'c-topbar-action': { text: 'Get started' } } }));
    const hero = c.layer('home', section('Hero', [
      L('badge', 'Eyebrow', { text: 'New: shared workspaces', tone: 'info' }),
      heading(`${name} helps small teams do their best work`, 'text-4xl'),
      para('Plan, create and ship together in one calm, focused place. No setup marathon required.'),
      row('Calls to action', [primary('Start free', 'home-start'), secondary('See how it works', 'home-tour')]),
    ], { paddingY: 'space-8', align: 'start' }));
    c.append(root, hero); ids.start = 'home-start';
    const features = c.layer('home', section('Features', [heading('Everything in one place', 'text-2xl', 2)]));
    const g = c.layer('home', grid('Feature grid', 3, []));
    for (const [t, b] of [['Plan with clarity', 'Turn ideas into clear, shared plans in minutes.'], ['Create together', 'Comment, review and decide without endless meetings.'], ['Ship with confidence', 'See what’s ready, what’s blocked and what’s next.']]) c.append(g, c.instance('home', { component: 'card', name: t, set: { title: t, body: b } }));
    c.append(features, g); c.append(root, features);
    const pricing = c.layer('home', section('Pricing', [heading('Simple pricing', 'text-2xl', 2), para('Start free. Upgrade when your team grows.')], {}, { background: 'surface-subtle' }));
    const plans = c.layer('home', grid('Plans', 3, []));
    for (const [t, price, v] of [['Starter', '$0 / month', 'default'], ['Team', '$12 per person / month', 'highlighted'], ['Business', 'Custom', 'default']] as const) c.append(plans, c.instance('home', { component: 'card', name: `${t} plan`, variant: v, set: { title: t, body: price } }));
    c.append(pricing, plans); c.append(root, pricing);
    c.append(root, c.layer('home', section('Footer', [para(`© 2026 ${name}. Made for teams who care about craft.`)], { paddingY: 'space-6' })));
  });
  c.screen({ id: 'signup', name: 'Sign up', states: ['success', 'error'], root: page('Sign up', []) }, root => {
    const form = c.layer('signup', section('Form', [heading('Create your account', 'text-2xl'), para('It takes less than a minute.')], { maxWidth: 480, align: 'stretch' }));
    for (const [label, ph] of [['Full name', 'Alex Morgan'], ['Work email', 'alex@company.com']] as const) c.append(form, c.instance('signup', { component: 'text-field', name: label, set: { label, placeholder: ph, help: label === 'Work email' ? 'We’ll send a confirmation link.' : 'As you’d like teammates to see it.' } }));
    c.append(form, c.layer('signup', L('checkbox', 'Terms', { label: 'I agree to the terms of service', required: true })));
    const submit = c.layer('signup', primary('Create account', 'signup-submit')); c.append(form, submit);
    const back = c.layer('signup', L('link', 'Back', { text: '← Back to home', color: 'accent' })); c.append(form, back); ids.back = back;
    c.append(root, form);
  });
  c.screen({ id: 'welcome', name: 'Welcome aboard', states: ['success'], root: page('Welcome aboard', []) }, root => {
    c.append(root, c.layer('welcome', section('Message', [L('icon', 'Success icon', { icon: 'success', label: 'Success', color: 'success', fontSize: 40 }), heading('You’re in!', 'text-3xl'), para('Check your inbox to confirm your email. Your workspace is ready when you are.')], { align: 'start' })));
  });
  c.on('home-start', 'navigate', { target: 'signup' });
  c.on('c-topbar-action', 'navigate', { target: 'signup' });
  c.interactions.push({ id: 'signup-validate', source: 'signup-submit', event: 'click', action: 'validate', transition: 'none' }, { id: 'signup-done', source: 'signup-submit', event: 'click', action: 'navigate', target: 'welcome', transition: 'slide' });
  c.on(ids.back, 'back');
}

function onboarding(c: Composer, name: string) {
  const step = (id: string, title: string, intro: string, n: number, fields: LayerSpec[], next: string | null, back: boolean) => {
    c.screen({ id, name: title, states: ['success', 'error'], root: page(title, []) }, root => {
      const s = c.layer(id, section('Step', [L('text', 'Step label', { text: `Step ${n} of 3`, color: 'text-muted', fontSize: 'text-sm', letterSpacing: 'tracking-wide' }), L('progress', 'Progress', { label: 'Setup progress', values: [Math.round((n / 3) * 100)] }), heading(title, 'text-2xl'), para(intro), ...fields], { maxWidth: 560, align: 'stretch' }));
      const actions = c.layer(id, row('Actions', [...(back ? [secondary('Back', `${id}-back`)] : []), primary(next ? 'Continue' : 'Finish setup', `${id}-next`)], { justify: 'end' }));
      c.append(s, actions); c.append(root, s);
      if (back) c.on(`${id}-back`, 'back');
      c.interactions.push({ id: `${id}-validate`, source: `${id}-next`, event: 'click', action: 'validate', transition: 'none' });
      c.on(`${id}-next`, 'navigate', { target: next ?? 'done', transition: 'slide' });
    });
  };
  c.screen({ id: 'welcome', name: 'Welcome', states: ['success'], root: page('Welcome', []) }, root => {
    c.append(root, c.layer('welcome', section('Welcome', [L('icon', 'Sparkle', { icon: 'sparkle', label: 'Welcome', color: 'accent', fontSize: 40 }), heading(`Welcome to ${name}`, 'text-3xl'), para('Let’s set up your workspace. It takes about two minutes and you can change everything later.'), primary('Get started', 'welcome-start')], { maxWidth: 560, align: 'start', paddingY: 'space-8' })));
  });
  step('profile', 'Your profile', 'Tell us a little about you so teammates know who you are.', 1, [
    L('input', 'Full name', { label: 'Full name', placeholder: 'Alex Morgan', required: true }),
    L('input', 'Job title', { label: 'Job title', placeholder: 'Product designer' }),
  ], 'preferences', false);
  step('preferences', 'Preferences', 'Choose how you’d like to work.', 2, [
    L('radio', 'Team size', { label: 'Team size', options: ['Just me', '2–10 people', '11–50 people', 'More than 50'], selected: 1 }),
    L('switch', 'Weekly summary', { label: 'Send me a weekly summary', checked: true }),
    L('switch', 'Tips', { label: 'Show tips while I work', checked: false }),
  ], 'done', true);
  c.screen({ id: 'done', name: 'All set', states: ['success'], root: page('All set', []) }, root => {
    const body = c.layer('done', section('Done', [L('progress', 'Progress', { label: 'Setup progress', values: [100] }), heading('You’re all set', 'text-3xl'), para('Your workspace is ready. Invite your team whenever you like.')], { maxWidth: 560, align: 'stretch' }));
    c.append(body, c.instance('done', { component: 'notification', name: 'Saved notice', set: { title: 'Profile saved', message: 'You can update these choices in Settings.' } }));
    c.append(root, body);
  });
  c.on('welcome-start', 'navigate', { target: 'profile', transition: 'slide' });
}

function commerce(c: Composer, name: string) {
  const ids: Record<string, string> = {};
  const product = (prefix: string, title: string, price: string, tone: string): LayerSpec => L('card', title, {}, { gap: 'space-3', padding: 'space-4' }, [
    L('shape', 'Product image', { background: tone, radius: 'radius-md' }, { height: 180 }),
    L('text', 'Name', { text: title, fontWeight: 'weight-medium' }),
    L('text', 'Price', { text: price, color: 'text-muted' }),
    L('button', 'Add to cart', { text: 'Add to cart', background: 'accent', color: 'on-accent', radius: 'radius-md' }, { width: 'fill' }, undefined, { id: `${prefix}-add` }),
  ]);
  c.screen({ id: 'shop', name: 'Shop', root: page('Shop', []) }, root => {
    c.append(root, c.instance('shop', { component: 'top-bar', name: 'Top bar', set: { brand: name }, overrides: { 'c-topbar-nav': { label: 'Shop sections', options: ['Shop', 'New arrivals', 'Journal'] }, 'c-topbar-action': { text: 'Cart (2)', icon: 'cart' } } }));
    const body = c.layer('shop', section('Catalog', [heading('Thoughtfully made, ready for you', 'text-3xl'), row('Filters', [L('input', 'Search', { label: 'Search products', placeholder: 'Search', inputType: 'search' }, { width: 280 }), L('select', 'Sort', { label: 'Sort by', options: ['Featured', 'Price: low to high', 'Price: high to low', 'Newest'], value: 'Featured' }, { width: 220 })], { align: 'end' })]));
    const g = c.layer('shop', grid('Products', 3, [product('shop-p1', 'Linen tote', '$48', 'brand-100'), product('shop-p2', 'Ceramic mug', '$24', 'amber-100'), product('shop-p3', 'Desk lamp', '$86', 'green-100')]));
    c.append(body, g); c.append(root, body);
    ids.cart = 'c-topbar-action';
  });
  c.screen({ id: 'product', name: 'Product', root: page('Product', []) }, root => {
    const body = c.layer('product', section('Product', [L('link', 'Back', { text: '← Back to shop', color: 'accent' }, {}, undefined, { id: 'product-back' })]));
    const detail = c.layer('product', grid('Detail', 2, [
      L('shape', 'Product image', { background: 'brand-100', radius: 'radius-lg' }, { height: 360 }),
      L('frame', 'Info', {}, { gap: 'space-4' }, [heading('Linen tote', 'text-3xl'), L('text', 'Price', { text: '$48', fontSize: 'text-xl' }), para('Woven from soft, durable linen with a roomy inside pocket. Made in small batches.'), L('select', 'Color', { label: 'Color', options: ['Natural', 'Charcoal', 'Olive'], value: 'Natural' }), L('button', 'Add to cart', { text: 'Add to cart', background: 'accent', color: 'on-accent', radius: 'radius-md' }, {}, undefined, { id: 'product-add' }), L('notification', 'Added notice', { text: 'Linen tote was added to your cart.', label: 'Added', tone: 'success' }, {}, undefined, { id: 'product-added' })]),
    ]));
    c.nodes['product-added'].hidden = true;
    c.append(body, detail); c.append(root, body);
  });
  c.screen({ id: 'cart', name: 'Cart', states: ['success', 'empty', 'loading', 'error'], root: page('Cart', []) }, root => {
    const body = c.layer('cart', section('Cart', [heading('Your cart', 'text-3xl'), L('table', 'Cart items', { label: 'Items in your cart', rows: [['Item', 'Qty', 'Price'], ['Linen tote', '1', '$48'], ['Ceramic mug', '2', '$48']] }), row('Total', [L('text', 'Total label', { text: 'Total', fontWeight: 'weight-medium' }), L('text', 'Total value', { text: '$96', fontSize: 'text-xl', fontWeight: 'weight-bold' })], { justify: 'between' }), row('Actions', [secondary('Keep shopping', 'cart-continue'), primary('Check out', 'cart-checkout')], { justify: 'end' })], { maxWidth: 760, align: 'stretch' }));
    c.append(root, body);
  });
  c.on('shop-p1-add', 'navigate', { target: 'product' });
  c.on('shop-p2-add', 'navigate', { target: 'product' });
  c.on('shop-p3-add', 'navigate', { target: 'product' });
  c.on('product-add', 'show', { target: 'product-added' });
  c.on('product-back', 'back');
  c.on(ids.cart, 'navigate', { target: 'cart' });
  c.on('cart-continue', 'navigate', { target: 'shop' });
}

function settings(c: Composer, name: string) {
  const shell = (id: string, title: string, selected: number, content: LayerSpec[], extra: (body: string) => void = () => {}) => c.screen({ id, name: title, states: ['success', 'empty', 'loading', 'error'], root: L('frame', title, { background: 'canvas', color: 'text', font: 'font-body' }, { direction: 'row', gap: 0, width: 'fill', minHeight: 720 }, [], { responsive: { phone: { direction: 'column' } } }) }, root => {
    c.append(root, c.instance(id, { component: 'sidebar', name: 'Sidebar', set: { brand: name }, layout: { width: 'hug' }, overrides: { 'c-sidebar-nav': { selected } } }));
    const body = c.layer(id, section('Content', [heading(title, 'text-2xl'), ...content], { maxWidth: 760, align: 'stretch' }));
    extra(body);
    c.append(root, body);
  });
  shell('profile', 'Profile', 0, [
    L('input', 'Display name', { label: 'Display name', value: 'Priya Shah', required: true }),
    L('input', 'Email', { label: 'Email address', value: 'priya@northwind.co', inputType: 'email', helperText: 'Used for sign-in and receipts.' }),
    L('select', 'Time zone', { label: 'Time zone', options: ['Eastern Time (US & Canada)', 'Pacific Time (US & Canada)', 'London', 'Berlin'], value: 'Eastern Time (US & Canada)' }),
    row('Actions', [primary('Save changes', 'profile-save')], { justify: 'end' }),
    L('notification', 'Saved notice', { text: 'Your profile was updated.', label: 'Saved', tone: 'success' }, {}, undefined, { id: 'profile-saved' }),
    L('divider', 'Divider'),
    row('Danger zone', [L('text', 'Danger text', { text: 'Delete your account and all of its data.', color: 'text-muted' }), L('button', 'Delete account', { text: 'Delete account', background: 'danger', color: 'on-danger', radius: 'radius-md' }, {}, undefined, { id: 'profile-delete' })], { justify: 'between' }),
  ], body => { c.nodes[body].children.splice(1, 0, c.instance('profile', { component: 'user-row', name: 'Person', set: { name: 'Priya Shah', role: 'Product lead' } })); });
  shell('notifications', 'Notifications', 1, [
    para('Choose what we email you about. In-app notifications are always on.'),
    L('switch', 'Mentions', { label: 'When someone mentions me', checked: true }),
    L('switch', 'Assigned', { label: 'When I’m assigned a task', checked: true }),
    L('switch', 'Digest', { label: 'Weekly digest', checked: false }),
  ]);
  shell('billing', 'Billing', 2, [
    L('card', 'Plan', {}, {}, [L('text', 'Plan name', { text: 'Team plan', fontWeight: 'weight-medium' }), L('text', 'Plan price', { text: '$12 per person / month · renews Nov 1', color: 'text-muted' }), L('button', 'Change plan', { text: 'Change plan', background: 'surface', color: 'text', border: true, borderColor: 'border-strong', radius: 'radius-md' }, { width: 'hug' })]),
    L('table', 'Invoices', { label: 'Invoices', rows: [['Date', 'Amount', 'Status'], ['Oct 1, 2026', '$96.00', 'Paid'], ['Sep 1, 2026', '$96.00', 'Paid'], ['Aug 1, 2026', '$84.00', 'Paid']] }),
  ]);
  c.screen({ id: 'delete-account', name: 'Delete account', kind: 'dialog', states: ['success'], root: L('frame', 'Delete account', { color: 'text', font: 'font-body' }, { padding: 0 }) }, root => {
    c.append(root, c.instance('delete-account', { component: 'dialog', name: 'Confirm deletion', variant: 'destructive', set: { title: 'Delete your account?', body: 'This permanently deletes your workspace and its data. You can’t undo this.', confirm: 'Delete account' } }));
  });
  c.nodes['profile-saved'].hidden = true;
  c.on('profile-save', 'show', { target: 'profile-saved' });
  c.on('profile-delete', 'open-overlay', { target: 'delete-account' });
  c.on('c-dialog-cancel', 'close-overlay');
  c.on('c-dialog-confirm', 'close-overlay');
  for (const [option, target] of [['Profile', 'profile'], ['Notifications', 'notifications'], ['Billing', 'billing']] as const) c.interactions.push({ id: `nav-${target}`, source: 'c-sidebar-nav', event: 'change', action: 'navigate', target, match: option, transition: 'fade' });
}

const BUILDERS: Record<DesignStarter, (c: Composer, name: string) => void> = { dashboard, landing, onboarding, commerce, settings };

export interface DesignStyleInput { tone?: DesignTone; brand?: string; typeface?: DesignTypeface; density?: DesignDocument['settings']['density'] }

/** A complete, valid document for a starter with generated foundations. */
export function createDesignDocument(id: string, name: string, starter: DesignStarter = 'dashboard', systemHash: string | null = null, style: DesignStyleInput = {}): DesignDocument {
  const tone = style.tone ?? 'calm';
  const c = new Composer();
  BUILDERS[starter](c, name);
  const tokens = generateFoundations({ brand: style.brand ?? TONE_BRANDS[tone], tone, typeface: style.typeface, density: style.density });
  const doc: DesignDocument = {
    schema: DESIGN_DOCUMENT_SCHEMA, id, name, version: 1, systemHash,
    screens: c.screens, nodes: c.nodes, components: c.components, tokens, assets: {}, fixtures: {}, interactions: c.interactions,
    content: DEFAULT_CONTENT, settings: { ...DEFAULT_SETTINGS, density: style.density ?? 'comfortable' },
    direction: directionText(tone, style.typeface ?? TONES[tone].typeface), libraries: [],
  };
  return parseDesignDocument(doc);
}

// ---- describe an idea ---------------------------------------------------------------------------

export const TONE_BRANDS: Record<DesignTone, string> = { calm: '#2563eb', bold: '#7c3aed', warm: '#c2410c', minimal: '#334155', playful: '#db2777' };
const KEYWORDS: [RegExp, DesignStarter][] = [
  [/\b(shop|store|commerce|cart|checkout|product|catalog|marketplace|retail|boutique|order)s?\b/i, 'commerce'],
  [/\b(onboard|sign ?up|setup|set up|welcome|getting started|wizard|first run)\w*\b/i, 'onboarding'],
  [/\b(settings?|preferences|account|profile|billing|admin panel)\b/i, 'settings'],
  [/\b(landing|marketing|homepage|home page|website|launch|waitlist|portfolio|agency|studio site)\b/i, 'landing'],
  [/\b(dashboard|analytics|metrics|admin|crm|tracker|workspace|internal tool|reporting|portal|app)\b/i, 'dashboard'],
];
const COLOR_WORDS: [RegExp, string][] = [
  [/\b(eco|green|garden|plant|sustainab|climate|farm|nature)\w*/i, '#15803d'], [/\b(finance|bank|invest|insur|legal|law)\w*/i, '#1e3a8a'],
  [/\b(health|clinic|care|wellness|medical|therapy)\w*/i, '#0f766e'], [/\b(food|restaurant|coffee|bakery|recipe|kitchen)\w*/i, '#c2410c'],
  [/\b(kid|child|school|learn|education|class)\w*/i, '#7c3aed'], [/\b(music|art|creative|design|studio|fashion)\w*/i, '#be185d'],
];
const TONE_WORDS: [RegExp, DesignTone][] = [[/\b(playful|fun|kids?|game|friendly and fun)\b/i, 'playful'], [/\b(bold|energetic|vibrant|startup|sport)\b/i, 'bold'], [/\b(warm|cozy|friendly|community|local)\b/i, 'warm'], [/\b(minimal|clean|simple|precise|technical|developer)\b/i, 'minimal']];

export interface DesignProposalInput { prompt: string; starter?: DesignStarter; tone?: DesignTone; brand?: string; typeface?: DesignTypeface; audience?: string; name?: string }
export interface DesignProposal {
  name: string; starter: DesignStarter; tone: DesignTone; brand: string; typeface: DesignTypeface; direction: string;
  palette: { role: string; light: string; dark: string }[];
  type: { heading: string; body: string; scale: number[] };
  components: string[];
  screens: string[];
  /** Short questions that still matter; each has a sensible default already applied. */
  questions: { id: 'audience' | 'tone' | 'brand'; label: string; options?: string[] }[];
}

export function inferStarter(prompt: string): DesignStarter {
  for (const [re, starter] of KEYWORDS) if (re.test(prompt)) return starter;
  return 'dashboard';
}
export function inferName(prompt: string): string {
  const words = prompt.replace(/[^\p{L}\p{N}\s'&-]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  while (words.length && /^(a|an|the|i|we|need|want|build|make|create|design|designing|for|my|our|me|please|new)$/i.test(words[0])) words.shift();
  const name = words.slice(0, 6).join(' ');
  return name ? (name[0].toUpperCase() + name.slice(1)).slice(0, 60) : 'Untitled design';
}
function directionText(tone: DesignTone, typeface: DesignTypeface, audience = '') {
  const t = TONES[tone];
  return `${t.label}. ${t.summary} ${TYPEFACES[typeface].label} type with ${t.radius[1] <= 4 ? 'crisp, nearly square' : t.radius[1] >= 14 ? 'soft, rounded' : 'gently rounded'} corners.${audience ? ` Designed for ${audience}.` : ''}`;
}

/** A complete first proposal from one sentence. Every choice can be changed before or after accepting it. */
export function proposeDesign(input: DesignProposalInput): DesignProposal & { document: (id: string, systemHash?: string | null) => DesignDocument } {
  const prompt = input.prompt.slice(0, 2000);
  const starter = input.starter ?? inferStarter(prompt);
  const tone = input.tone ?? TONE_WORDS.find(([re]) => re.test(prompt))?.[1] ?? 'calm';
  const brand = input.brand && /^#[0-9a-fA-F]{6}$/.test(input.brand) ? input.brand.toLowerCase() : COLOR_WORDS.find(([re]) => re.test(prompt))?.[1] ?? TONE_BRANDS[tone];
  const typeface = input.typeface ?? TONES[tone].typeface;
  const name = input.name?.trim().slice(0, 150) || inferName(prompt);
  const tokens = generateFoundations({ brand, tone, typeface });
  const palette = ['canvas', 'surface', 'text', 'text-muted', 'accent', 'on-accent', 'success', 'danger'].map(role => ({ role, light: String(resolveToken(tokens, role)), dark: String(resolveToken(tokens, role, true)) }));
  const audience = input.audience?.trim().slice(0, 200) ?? '';
  const direction = directionText(tone, typeface, audience);
  const lib = new Map(starterLibrary().map(c => [c.component.id, c.component.name]));
  const c = new Composer(); BUILDERS[starter](c, name);
  return {
    name, starter, tone, brand, typeface, direction, palette,
    type: { heading: String(tokens['font-heading'].value), body: String(tokens['font-body'].value), scale: ['text-sm', 'text-md', 'text-xl', 'text-3xl'].map(k => Number(tokens[k].value)) },
    components: Object.keys(c.components).map(k => lib.get(k) ?? k),
    screens: c.screens.map(s => s.name),
    questions: [
      { id: 'audience', label: 'Who is it for?' },
      { id: 'tone', label: 'How should it feel?', options: Object.keys(TONES) },
      { id: 'brand', label: 'Main brand color' },
    ],
    document: (id: string, systemHash: string | null = null) => {
      const doc = createDesignDocument(id, name, starter, systemHash, { tone, brand, typeface });
      return { ...doc, direction };
    },
  };
}

/** Operations that add a starter-library component (with its layers) to a document, or null if present. */
export function libraryComponentOps(d: DesignDocument, componentId: string): { type: 'add-component'; value: DesignComponent; nodes: DesignNode[] } | null {
  if (d.components[componentId]) return null;
  const lib = starterLibrary().find(c => c.component.id === componentId);
  if (!lib) throw new Error('Unknown library component');
  if (lib.nodes.some(n => Object.hasOwn(d.nodes, n.id))) throw new Error(`Layer names used by ${lib.component.name} already exist in this design`);
  return { type: 'add-component', value: lib.component, nodes: lib.nodes };
}

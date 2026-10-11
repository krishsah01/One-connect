// SPDX-License-Identifier: Apache-2.0 AND LicenseRef-Commons-Clause-1.0
// The structured design format shared by the editor, agents, the renderer and the React export.
// It is data only: no executable expressions, raw HTML, URLs or free-form CSS. Every style value is
// either a validated number or a reference to a validated token.
//
// This file is copied verbatim into exported source packages, so it must not import anything.

/** Element kinds the application-owned renderer knows how to draw. */
export type DesignNodeKind =
  | 'frame' | 'card' | 'dialog' | 'drawer' | 'slot' | 'instance'
  | 'text' | 'image' | 'icon' | 'shape' | 'divider' | 'badge' | 'avatar' | 'link'
  | 'button' | 'input' | 'textarea' | 'checkbox' | 'radio' | 'switch' | 'select'
  | 'tabs' | 'menu' | 'navigation' | 'pagination' | 'tooltip'
  | 'notification' | 'progress' | 'spinner' | 'skeleton'
  | 'table' | 'chart' | 'list';

/** Simulated data scenarios a prototype can be previewed in. */
export type DesignContentState = 'success' | 'empty' | 'loading' | 'error' | 'partial' | 'permission' | 'offline';

/** A style value: a number in pixels (or unitless where noted), or the id of a token. */
export type DesignValue = number | string;

export interface DesignLayout {
  direction?: 'column' | 'row' | 'grid';
  gap?: DesignValue;
  padding?: DesignValue;
  paddingX?: DesignValue;
  paddingY?: DesignValue;
  columns?: number;
  wrap?: boolean;
  align?: 'start' | 'center' | 'end' | 'stretch';
  justify?: 'start' | 'center' | 'end' | 'between';
  width?: number | 'fill' | 'hug';
  height?: number | 'fill' | 'hug';
  minWidth?: number;
  maxWidth?: DesignValue;
  minHeight?: number;
  position?: 'flow' | 'absolute';
  x?: number;
  y?: number;
}
/** Layout overrides for one breakpoint, plus whether the layer shows there and its text size. */
export interface DesignResponsive extends DesignLayout { hidden?: boolean; fontSize?: DesignValue }

export type DesignIcon =
  | 'star' | 'check' | 'plus' | 'minus' | 'close' | 'search' | 'arrow-right' | 'arrow-left' | 'chevron-down' | 'chevron-right'
  | 'heart' | 'home' | 'user' | 'users' | 'settings' | 'bell' | 'mail' | 'calendar' | 'chart' | 'folder' | 'file'
  | 'cart' | 'bag' | 'lock' | 'info' | 'warning' | 'error' | 'success' | 'menu' | 'more' | 'filter' | 'upload'
  | 'download' | 'edit' | 'trash' | 'link' | 'globe' | 'sparkle' | 'moon' | 'sun';

/** Fields an instance may override on a layer inside its component. */
export interface DesignOverride {
  text?: string; label?: string; value?: string; placeholder?: string; helperText?: string;
  assetId?: string; hidden?: boolean; color?: string; background?: string; icon?: DesignIcon;
  options?: string[]; selected?: number;
}

export interface DesignNodeProps {
  // content
  text?: string; label?: string; placeholder?: string; value?: string; helperText?: string; errorText?: string;
  required?: boolean; disabled?: boolean; checked?: boolean; selected?: number;
  options?: string[]; rows?: string[][]; values?: number[]; chart?: 'bar' | 'line' | 'donut';
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  inputType?: 'text' | 'email' | 'number' | 'password' | 'search' | 'tel' | 'date';
  level?: 1 | 2 | 3 | 4 | 5 | 6;
  assetId?: string; alt?: string; fit?: 'cover' | 'contain';
  crop?: { x: number; y: number; zoom: number };
  icon?: DesignIcon; iconPosition?: 'start' | 'end';
  // style: token ids or validated numbers
  color?: string; background?: string; borderColor?: string; shadow?: string; font?: string;
  radius?: DesignValue; fontSize?: DesignValue; lineHeight?: DesignValue; letterSpacing?: DesignValue; fontWeight?: DesignValue;
  textAlign?: 'left' | 'center' | 'right'; opacity?: number; border?: boolean; layer?: DesignValue;
  // components
  componentId?: string; variant?: string; componentState?: string; overrides?: Record<string, DesignOverride>;
  /** On a child of an instance: the slot layer (inside the component) this child fills. */
  slot?: string;
  // prototype data
  visibleWhen?: { fixture: string; equals: string };
  bind?: { fixture: string; field: 'text' | 'value' | 'label' };
  state?: DesignContentState;
}

export interface DesignNode {
  id: string;
  name: string;
  kind: DesignNodeKind;
  children: string[];
  props: DesignNodeProps;
  layout: DesignLayout;
  responsive?: { phone?: DesignResponsive; tablet?: DesignResponsive };
  locked?: boolean;
  hidden?: boolean;
}

export interface DesignScreen {
  id: string;
  name: string;
  root: string;
  states: DesignContentState[];
  /** Pages are full screens; dialogs and drawers open over another screen. */
  kind?: 'page' | 'dialog' | 'drawer';
  description?: string;
  /** An uploaded screenshot kept beside an editable reconstruction. Never exported as content. */
  reference?: { assetId: string; opacity: number };
  /** Where the screen sits on the user-flow map. */
  flow?: { x: number; y: number };
}

/** A value an instance can set, mapped onto one field of a layer inside the component. */
export interface DesignComponentProp {
  id: string;
  label: string;
  node: string;
  field: 'text' | 'label' | 'value' | 'placeholder' | 'helperText' | 'assetId' | 'hidden';
  defaultValue?: string;
}

export interface DesignComponent {
  id: string;
  name: string;
  root: string;
  description: string;
  category?: string;
  /** Variant name → property overrides for layers inside the component. */
  variants: Record<string, Record<string, DesignNodeProps>>;
  /** Interactive states (hover, disabled, loading, error…) in the same form. */
  states?: Record<string, Record<string, DesignNodeProps>>;
  props?: DesignComponentProp[];
  /** Slot layers inside the component that instances may fill. */
  slots?: string[];
  usage?: string;
  accessibility: string;
  /** Where a library copy came from, so later library updates can be reviewed. */
  source?: { kitId: string; version: number };
}

export type DesignTokenType =
  | 'color' | 'dimension' | 'font' | 'fontWeight' | 'lineHeight' | 'letterSpacing'
  | 'shadow' | 'duration' | 'easing' | 'opacity' | 'layer' | 'number';

export interface DesignTokenValue {
  type: DesignTokenType;
  value: string | number;
  /** Dark-theme value; falls back to `value`. */
  dark?: string | number;
  /** Another token of the same type this token resolves to. */
  alias?: string;
  /** In the dark theme, resolve to this token instead (takes precedence over `dark`). */
  darkAlias?: string;
  description: string;
  /** Primitive scales feed semantic roles; components should use semantic tokens. */
  tier?: 'primitive' | 'semantic';
  /** Grouping such as palette, spacing, radius, type-scale, breakpoint or motion. */
  category?: string;
  source?: { kitId: string; version: number };
}

export interface DesignAsset {
  id: string;
  name: string;
  hash: string;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  bytes: number;
  /** True for screenshots and brand references kept for comparison. */
  reference: boolean;
}

export type DesignInteractionAction =
  | 'navigate' | 'back' | 'open-overlay' | 'close-overlay'
  | 'set-state' | 'set-variant' | 'set-value' | 'toggle' | 'show' | 'hide' | 'validate' | 'select-tab';

export interface DesignInteraction {
  id: string;
  source: string;
  event: 'click' | 'submit' | 'change';
  action: DesignInteractionAction;
  target?: string;
  value?: string;
  transition: 'none' | 'fade' | 'slide' | 'scale';
  /** For change events: run only when the new value equals this (for example one navigation item). */
  match?: string;
  /** Run only when a fixture currently has this value. */
  when?: { fixture: string; equals: string };
}

/** Voice, wording and formatting conventions that keep copy consistent across screens. */
export interface DesignContentGuide {
  voice: string;
  /** Preferred words: use one term, avoid the alternatives. */
  terms: { use: string; avoid: string }[];
  formats: { date: string; number: string; currency: string };
  /** Copy shown for simulated data states. */
  states: { empty: string; loading: string; error: string; permission: string; offline: string };
  helperText: string;
  errorText: string;
}

export interface DesignSettings {
  breakpoints: { phone: number; tablet: number };
  density: 'compact' | 'comfortable' | 'spacious';
  /** Maximum content width in pixels. */
  container: number;
  grid: { columns: number; gutter: number };
  /** Reduced motion keeps meaning with opacity changes only. */
  motion: 'full' | 'reduced';
}

export interface DesignDocument {
  schema: 2;
  id: string;
  name: string;
  version: number;
  /** The published project system this draft was last aligned with. */
  systemHash: string | null;
  screens: DesignScreen[];
  nodes: Record<string, DesignNode>;
  components: Record<string, DesignComponent>;
  tokens: Record<string, DesignTokenValue>;
  assets: Record<string, DesignAsset>;
  fixtures: Record<string, string>;
  interactions: DesignInteraction[];
  content: DesignContentGuide;
  settings: DesignSettings;
  /** One-paragraph visual direction, written by the person or proposed by an agent. */
  direction: string;
  /** Local library kits this document copied components or tokens from. */
  libraries: { kitId: string; version: number; name: string }[];
}

export interface DesignDocumentFinding {
  id: string;
  severity: 'error' | 'warning';
  /** Stable rule name so reviewers and agents can group and repair findings. */
  rule: string;
  message: string;
  nodeId?: string;
  screenId?: string;
  componentId?: string;
  tokenId?: string;
}

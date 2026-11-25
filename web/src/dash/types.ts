// What the home page dashboard sends and receives (the rules and limits are in src/books/dashboardRules.ts).
import type { LayoutDoc, PeriodSpec } from '../../../src/books/dashboardRules.ts';
export type { LayoutDoc, LayoutWidget, PeriodSpec, PeriodKind } from '../../../src/books/dashboardRules.ts';

export interface Catalog { key: string; sizes: string[]; defaultSize: string; charts: string[]; defaultChart: string; usesPeriod: boolean; client: boolean }
export interface Drill { module: string; sub: string; item?: string; extra?: string; query: Record<string, string> }
export interface Result { id: string; type: string; state: 'ok' | 'empty' | 'forbidden' | 'error'; empty?: string; from?: string; to?: string; data?: unknown; drill?: Drill; foreign?: boolean }
export interface Dash { layout: LayoutDoc; source: 'user' | 'role' | 'company' | 'default'; catalog: Catalog[]; today: string; currency: string }
export interface Defaults { company: LayoutDoc | null; roles: { id: string; name: string; nameAr: string | null; layout: LayoutDoc | null }[]; catalog: Catalog[]; builtIn: LayoutDoc }
export type Period = PeriodSpec;

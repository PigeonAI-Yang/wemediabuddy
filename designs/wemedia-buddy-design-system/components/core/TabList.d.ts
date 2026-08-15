/**
 * TabList — keyboard-complete tablist (roving tabindex,
 * Arrow/Home/End). Source: .proposal-tab grammar with real
 * tablist/tab semantics (WMB-5258 §4, library tabs contract).
 *
 * Usage:
 *   <TabList tabs={[{id:'today',label:'今日可批',count:3},{id:'shelved',label:'待处理',count:9}]}
 *            selectedId={tab} onSelect={setTab} ariaLabel="选题台账" />
 *
 * Props:
 * - tabs: { id, label, count? }[]
 * - selectedId: controlled selection
 * - onSelect(id): called on click and arrow navigation
 * - ariaLabel: tablist accessible name (required)
 * - className
 */
export interface TabListProps {
  tabs: TabItem[];
  selectedId: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
  className?: string;
}
export type TabItem = {
  id: string;
  label: string;
  count?: number;
};

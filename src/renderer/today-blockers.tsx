import type { TodayRunView } from './today-run-view';

export function TodayBlockers(props: {
  blockers: TodayRunView['blockers'];
  onAction: (action: TodayRunView['blockers'][number]['action']) => void;
}): React.JSX.Element | null {
  if (!props.blockers.length) return null;
  return (
    <>
      <p className="eyebrow">待你处理 · {props.blockers.length}</p>
      {props.blockers.map((blocker) => (
        <button
          type="button"
          className="action-card action-card-button"
          key={`${blocker.code}:${blocker.title}`}
          onClick={() => props.onAction(blocker.action)}
        >
          <div className="action-icon" aria-hidden="true">✋</div>
          <div>
            <div className="action-title">{blocker.title}</div>
            <div className="action-sub">{blocker.body}</div>
            <div className="action-sub action-link">点击处理</div>
          </div>
        </button>
      ))}
    </>
  );
}

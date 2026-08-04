export function WmbCreatureMark({ state = 'idle', className = '' }: { state?: 'idle' | 'working' | 'settling'; className?: string }): React.JSX.Element {
  return <span className={`wmb-creature-mark is-${state}${className ? ` ${className}` : ''}`} aria-hidden="true"><svg viewBox="0 0 32 32">
    <g className="wmb-creature-body">
      <path className="wmb-creature-white" d="M3 4h5l5.2 13 2.8-4 2.8 4L24 4h5l-8 25-5-7-5 7z"/>
      <path className="wmb-creature-purple" d="M24 4h5l-5.5 17-4.7-6.7z"/>
      <g className="wmb-creature-eye">
        <path d="M9.5 17Q16 10 22.5 17Q16 24 9.5 17Z"/>
        <circle className="wmb-creature-pupil" cx="16" cy="17" r="2.5"/>
      </g>
    </g>
  </svg></span>;
}

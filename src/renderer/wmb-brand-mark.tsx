import { useId } from 'react';

export function WmbCreatureMark({ state = 'idle', className = '' }: { state?: 'idle' | 'connect' | 'working' | 'settling' | 'sleep' | 'scout'; className?: string }): React.JSX.Element {
  const eyeClipId = useId();
  return <span className={`wmb-creature-mark is-${state}${className ? ` ${className}` : ''}`} aria-hidden="true"><svg className="wmb-creature-logo" viewBox="0 0 751 510">
    <defs><clipPath id={eyeClipId}><path d="M216,264 L229,248 L256,221 L274,207 L297,193 L317,184 L341,177 L359,174 L392,174 L411,177 L434,184 L454,193 L474,205 L496,222 L512,237 L532,259 L536,266 L490,304 L465,320 L445,330 L427,337 L402,343 L386,345 L363,345 L331,339 L311,332 L285,319 L251,296 L216,266Z"/></clipPath></defs>
    <g className="wmb-creature-body">
      <path className="wmb-creature-purple" d="M749,0 L615,1 L534,200 L531,203 L540,210 L540,212 L538,213 L544,213 L553,222 L552,225 L556,225 L556,230 L557,228 L559,228 L564,233 L563,238 L569,239 L578,248 L577,252 L579,253 L579,255 L584,255 L596,268 L594,272 L599,277 L604,277 L603,280 L607,281 L606,284 L609,284 L612,287 L611,291 L615,295 L618,294 L621,298 L621,300 L618,302 L623,301 L625,307 L643,267 L751,2Z"/>
      <path className="wmb-creature-white" fillRule="evenodd" d="M0,1 L211,510 L216,509 L246,455 L309,349 L357,373 L371,377 L380,377 L396,371 L415,361 L442,343 L445,343 L450,350 L534,505 L538,510 L541,510 L543,508 L626,306 L589,261 L529,200 L377,77 L374,77 L226,197 L220,200 L216,194 L138,1Z M216,264 L229,248 L256,221 L274,207 L297,193 L317,184 L341,177 L359,174 L392,174 L411,177 L434,184 L454,193 L474,205 L496,222 L512,237 L532,259 L536,266 L490,304 L465,320 L445,330 L427,337 L402,343 L386,345 L363,345 L331,339 L311,332 L285,319 L251,296 L216,266Z"/>
      <g className="wmb-creature-pupil-track"><path className="wmb-creature-pupil" d="M370,213 L358,216 L350,220 L340,228 L331,242 L328,252 L327,264 L331,280 L336,289 L343,297 L356,305 L365,308 L378,309 L392,306 L403,300 L411,293 L420,278 L423,258 L420,244 L414,233 L407,225 L400,220 L386,214Z"/></g>
      <g className="wmb-creature-lids" clipPath={`url(#${eyeClipId})`}><path className="wmb-creature-upper-lid" d="M180,-200 H570 V174 C485,242 285,242 180,174 Z"/></g>
    </g>
  </svg><svg className="wmb-creature-connect-current" viewBox="0 0 230 158"><path d="M18 88 L48 88 L58 72 L72 103 L88 80"/><path d="M212 70 L183 70 L171 53 L157 91 L142 76"/></svg><span className="wmb-creature-work-fx"><i className="work-item one"/><i className="work-item two"/><i className="work-progress"/></span></span>;
}

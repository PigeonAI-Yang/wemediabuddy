import { useEffect, useMemo, useState } from 'react';
import type { OnboardingAiTestResult, OnboardingStatus, OnboardingStep } from '../main/onboarding';
import { logoUrl } from './app-types';

const stepOrder: OnboardingStep[] = ['welcome', 'workspace', 'ai', 'platforms', 'complete'];
const stepLabels: Record<OnboardingStep, string> = { welcome: '开始', workspace: '工作空间', ai: 'AI 连接', platforms: '平台账号', complete: '完成' };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function OnboardingView({ initialStatus, onComplete }: { initialStatus: OnboardingStatus; onComplete: () => void }): React.JSX.Element {
  const [status, setStatus] = useState(initialStatus);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const refresh = async () => { const next = await window.wmb.getOnboardingStatus(); setStatus(next); return next; };
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true); setNote('');
    try { await work(); await refresh(); }
    catch (error) { setNote(errorText(error)); }
    finally { setBusy(false); }
  };
  const go = (step: Exclude<OnboardingStep, 'complete'>) => run(() => window.wmb.recordOnboardingStep(step));
  return <main className="onboarding-shell">
    <header className="onboarding-titlebar">
      <div className="onboarding-brand"><img src={logoUrl} alt=""/><strong>WeMediaBuddy</strong></div>
      <div className="titlebar-actions">
        <button aria-label="最小化窗口" onClick={() => void window.wmb.windowControl('minimize')}>−</button>
        <button aria-label="最大化或还原窗口" onClick={() => void window.wmb.windowControl('maximize')}>□</button>
        <button className="window-close" aria-label="关闭窗口" onClick={() => void window.wmb.windowControl('close')}>×</button>
      </div>
    </header>
    <div className="onboarding-layout">
      <aside className="onboarding-rail">
        <div><span className="eyebrow">FIRST RUN</span><h1>把创作系统<br/>安顿好。</h1><p>四步完成本地工作空间、AI 与平台账号。进度会自动保存。</p></div>
        <ol>{stepOrder.slice(0, 4).map((step, index) => <li key={step} className={status.currentStep === step ? 'active' : stepOrder.indexOf(status.currentStep) > index ? 'done' : ''}><span>{index + 1}</span>{stepLabels[step]}</li>)}</ol>
        <small>数据与密钥只保存在本机。</small>
      </aside>
      <section className="onboarding-stage">
        {status.currentStep === 'welcome' && <WelcomeStep busy={busy} next={() => void go('workspace')}/>} 
        {status.currentStep === 'workspace' && <WorkspaceStep busy={busy} createDefault={() => void run(() => window.wmb.createDefaultWorkspace())} choose={() => void run(() => window.wmb.chooseOnboardingWorkspace())}/>} 
        {status.currentStep === 'ai' && <AiStep busy={busy} onBusy={setBusy} onNote={setNote} afterSave={refresh}/>} 
        {status.currentStep === 'platforms' && <PlatformsStep status={status} busy={busy} onBusy={setBusy} onNote={setNote} refresh={refresh} finish={async () => { setBusy(true); setNote(''); try { for (const id of ['xiaohongshu', 'x', 'wechat']) if (!status.platforms[id]) await window.wmb.setOnboardingPlatform(id, 'skipped'); await window.wmb.completeOnboarding(); onComplete(); } catch (error) { setNote(errorText(error)); } finally { setBusy(false); } }}/>} 
        {status.currentStep === 'complete' && <div className="onboarding-card"><span className="eyebrow">READY</span><h2>准备好了</h2><p>工作空间与 AI 已就绪。</p><button className="onboarding-primary" onClick={onComplete}>进入 WeMediaBuddy</button></div>}
        {note && <p className="onboarding-note error" role="alert">{note}</p>}
      </section>
    </div>
  </main>;
}

function WelcomeStep({ busy, next }: { busy: boolean; next: () => void }): React.JSX.Element {
  return <div className="onboarding-card onboarding-welcome"><span className="eyebrow">WELCOME</span><h2>先连接你的创作基础设施</h2><p className="onboarding-lead">不导入云端，不替你决定。WeMediaBuddy 只把工作空间、模型和发布账号接到同一张桌面上。</p><div className="onboarding-promise"><div><strong>01</strong><span>本地优先</span></div><div><strong>02</strong><span>自带模型</span></div><div><strong>03</strong><span>账号隔离</span></div></div><button className="onboarding-primary" disabled={busy} onClick={next}>开始配置</button></div>;
}

function WorkspaceStep({ busy, createDefault, choose }: { busy: boolean; createDefault: () => void; choose: () => void }): React.JSX.Element {
  return <div className="onboarding-card"><span className="eyebrow">STEP 01</span><h2>选择内容与数据住在哪里</h2><p className="onboarding-lead">推荐使用“文档”里的 WeMediaBuddy 文件夹。数据、素材、导出和日志都在这里，随时可备份。</p><div className="onboarding-choice featured"><div><span className="choice-kicker">推荐</span><h3>创建默认工作空间</h3><p>文档\WeMediaBuddy</p></div><button className="onboarding-primary" disabled={busy} onClick={createDefault}>{busy ? '正在创建…' : '一键创建'}</button></div><div className="onboarding-choice"><div><h3>使用自定义目录</h3><p>选择新目录，或接入已有的 WeMediaBuddy 数据目录。</p></div><button className="secondary-button" disabled={busy} onClick={choose}>选择目录</button></div></div>;
}

function AiStep({ busy, onBusy, onNote, afterSave }: { busy: boolean; onBusy: (value: boolean) => void; onNote: (value: string) => void; afterSave: () => Promise<unknown> }): React.JSX.Element {
  const [name, setName] = useState('我的 AI');
  const [api, setApi] = useState<'openai-responses' | 'openai-completions'>('openai-responses');
  const [baseUrl, setBaseUrl] = useState('https://api.openai.com/v1');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState('');
  const [tested, setTested] = useState<OnboardingAiTestResult | null>(null);
  const invalidate = () => setTested(null);
  const input = useMemo(() => ({ name, api, baseUrl, apiKey, model }), [name, api, baseUrl, apiKey, model]);
  const test = async () => { onBusy(true); onNote(''); try { const result = await window.wmb.testOnboardingAi({ api, baseUrl, apiKey, model }); setTested(result); } catch (error) { setTested(null); onNote(errorText(error)); } finally { onBusy(false); } };
  const save = async () => { if (!tested) return; onBusy(true); onNote(''); try { await window.wmb.saveOnboardingAi(input, tested); setApiKey(''); await afterSave(); } catch (error) { onNote(errorText(error)); } finally { onBusy(false); } };
  return <div className="onboarding-card"><span className="eyebrow">STEP 02</span><h2>连接你的 AI 模型</h2><p className="onboarding-lead">保存前会真实连接一次，确认密钥与模型可用。密钥使用系统加密存储。</p><div className="onboarding-form"><label>配置名称<input value={name} onChange={(event) => { setName(event.target.value); invalidate(); }}/></label><label>接口协议<select value={api} onChange={(event) => { setApi(event.target.value as typeof api); invalidate(); }}><option value="openai-responses">OpenAI Responses</option><option value="openai-completions">Chat Completions</option></select></label><label className="wide">Base URL<input value={baseUrl} onChange={(event) => { setBaseUrl(event.target.value); invalidate(); }} placeholder="https://api.example.com/v1"/></label><label>API Key<input type="password" value={apiKey} onChange={(event) => { setApiKey(event.target.value); invalidate(); }} autoComplete="off"/></label><label>模型名称<input value={model} onChange={(event) => { setModel(event.target.value); invalidate(); }} placeholder="gpt-5.4"/></label></div>{tested && <div className="onboarding-success"><strong>连接成功 · {tested.latencyMs} ms</strong><span>{tested.model}{tested.visionModelId ? ` · 视觉 ${tested.visionModelId}` : ' · 未检测到视觉模型（不影响继续）'}</span></div>}<div className="onboarding-actions"><button className="secondary-button" disabled={busy || !apiKey || !model} onClick={() => void test()}>{busy ? '正在测试…' : '测试连接'}</button><button className="onboarding-primary" disabled={busy || !tested} onClick={() => void save()}>保存并继续</button></div></div>;
}

function PlatformsStep({ status, busy, onBusy, onNote, refresh, finish }: { status: OnboardingStatus; busy: boolean; onBusy: (value: boolean) => void; onNote: (value: string) => void; refresh: () => Promise<unknown>; finish: () => Promise<void> }): React.JSX.Element {
  const [settings, setSettings] = useState<Awaited<ReturnType<typeof window.wmb.getSettings>>>(null);
  useEffect(() => { void window.wmb.getSettings().then(setSettings); }, []);
  const mark = async (id: string, state: 'completed' | 'skipped') => { onBusy(true); onNote(''); try { await window.wmb.setOnboardingPlatform(id, state); await refresh(); } catch (error) { onNote(errorText(error)); } finally { onBusy(false); } };
  const verify = async (platform: 'x' | 'wechat') => { if (!settings?.browserBinding) { onNote('登录环境尚未绑定，请稍后在设置中完成。'); return; } onBusy(true); onNote(''); try { await window.wmb.verifyBrowserAccount({ workspaceId: settings.workspace.id, expectedBindingRevision: settings.browserBinding.bindingRevision, expectedRegistryRevision: settings.browserRegistryRevision, platform }); await mark(platform, 'completed'); } catch (error) { onNote(errorText(error)); } finally { onBusy(false); } };
  const xhsLogin = async () => { onBusy(true); onNote(''); try { await window.wmb.ensureXhs(); const result = await window.wmb.startXhsLogin(); if (!result.ok) throw new Error(result.error || '未能打开小红书登录'); onNote('已打开小红书登录窗口。登录完成后点击“已登录”。'); } catch (error) { onNote(errorText(error)); } finally { onBusy(false); } };
  const cards = [
    { id: 'xiaohongshu', name: '小红书', detail: '扫码登录专用发布窗口', action: xhsLogin },
    { id: 'x', name: 'X', detail: '在专用浏览器中验证当前登录账号', action: () => verify('x') },
    { id: 'wechat', name: '微信公众号', detail: '验证公众号后台登录状态', action: () => verify('wechat') }
  ];
  return <div className="onboarding-card"><span className="eyebrow">STEP 03 · OPTIONAL</span><h2>连接发布平台</h2><p className="onboarding-lead">平台账号不是启动前置条件。现在登录，或跳过后在设置中补充。</p><div className="platform-grid">{cards.map((card) => { const state = status.platforms[card.id]?.status; return <article key={card.id} className={`platform-card ${state ?? ''}`}><div className={`platform-mark ${card.id}`}>{card.id === 'xiaohongshu' ? 'RED' : card.id === 'wechat' ? 'WX' : 'X'}</div><div><h3>{card.name}</h3><p>{state === 'completed' ? '已完成' : state === 'skipped' ? '已跳过' : card.detail}</p></div>{state ? <button className="secondary-button" disabled={busy} onClick={() => void card.action()}>重新连接</button> : <><button className="secondary-button" disabled={busy} onClick={() => void card.action()}>开始登录</button>{card.id === 'xiaohongshu' && <button className="text-button" disabled={busy} onClick={() => void mark(card.id, 'completed')}>已登录</button>}<button className="text-button" disabled={busy} onClick={() => void mark(card.id, 'skipped')}>跳过</button></>}</article>; })}</div><div className="onboarding-actions"><button className="onboarding-primary" disabled={busy} onClick={() => void finish()}>进入 WeMediaBuddy</button></div></div>;
}

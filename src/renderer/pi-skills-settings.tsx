import { useEffect, useState } from 'react';
import { appConfirm } from './app-confirm';

type PiSkill = Awaited<ReturnType<typeof window.wmb.listPiSkills>>[number];

export function PiSkillsSettings(): React.JSX.Element {
  const [skills, setSkills] = useState<PiSkill[]>([]);
  const [selectedName, setSelectedName] = useState('');
  const [originalName, setOriginalName] = useState<string | undefined>();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [note, setNote] = useState('');
  const selected = skills.find((skill) => skill.name === selectedName) ?? null;

  const load = async (preferred?: string) => {
    const listed = await window.wmb.listPiSkills();
    setSkills(listed);
    const next = listed.find((skill) => skill.name === preferred) ?? listed[0] ?? null;
    if (next) select(next); else createNew();
  };
  const select = (skill: PiSkill) => {
    setSelectedName(skill.name);
    setOriginalName(skill.editable ? skill.name : undefined);
    setName(skill.name);
    setDescription(skill.description);
    setInstructions(skill.instructions);
    setNote('');
  };
  const createNew = () => {
    setSelectedName(''); setOriginalName(undefined); setName(''); setDescription(''); setInstructions(''); setNote('');
  };
  useEffect(() => { void load().catch((error) => setNote(error instanceof Error ? error.message : '读取 Skill 失败')); }, []);

  const save = async () => {
    try {
      const saved = await window.wmb.savePiSkill({ originalName, name, description, instructions });
      await load(saved.name);
      setNote('已保存。新的 Pi 会话会使用此版本。');
    } catch (error) { setNote(error instanceof Error ? error.message : '保存失败'); }
  };
  const remove = async () => {
    if (!selected?.editable) return;
    if (!await appConfirm({ title: '删除 Skill', message: `删除 Skill“${selected.name}”？`, confirmLabel: '删除', danger: true })) return;
    try {
      await window.wmb.deletePiSkill(selected.name);
      await load();
      setNote('已删除，所有工作空间的新 Pi 会话都不会再加载它。');
    } catch (error) { setNote(error instanceof Error ? error.message : '删除失败'); }
  };

  return <section className="settings-section pi-skills-settings">
    <div className="settings-section-heading"><h3>Skill 清单</h3></div>
    <div className="pi-skills-layout">
      <div className="pi-skills-list">
        {skills.map((skill) => <button type="button" key={`${skill.scope}:${skill.name}`} className={selectedName === skill.name ? 'selected' : ''} onClick={() => select(skill)}>
          <span><strong>{skill.name}</strong><small>{skill.description}</small></span>
          <em>{skill.editable ? (skill.origin === 'bundled' ? '内置 · 可编辑' : '用户 · 可编辑') : skill.scope === 'workspace' ? '当前工作空间 · 只读' : '系统 · 只读'}</em>
        </button>)}
        <button type="button" className={!selectedName ? 'selected add' : 'add'} onClick={createNew}>＋ 新建 Skill</button>
      </div>
      <div className="pi-skill-editor">
        <label><span>名称</span><input value={name} readOnly={Boolean(selected && !selected.editable)} onChange={(event) => setName(event.target.value)} placeholder="lowercase-hyphen-name" /></label>
        <label><span>触发描述</span><textarea rows={4} value={description} readOnly={Boolean(selected && !selected.editable)} onChange={(event) => setDescription(event.target.value)} placeholder="说明这个 Skill 做什么，以及哪些表达应触发它。" /></label>
        <label><span>指令</span><textarea className="pi-skill-instructions" value={instructions} readOnly={Boolean(selected && !selected.editable)} onChange={(event) => setInstructions(event.target.value)} placeholder="# 工作流程" /></label>
        {note && <p className="settings-note">{note}</p>}
        <div className="settings-form-actions">
          {selected?.editable && <button type="button" className="danger-button" onClick={() => void remove()}>删除</button>}
          {(!selected || selected.editable) && <button type="button" className="primary-button" onClick={() => void save()}>保存 Skill</button>}
        </div>
      </div>
    </div>
  </section>;
}

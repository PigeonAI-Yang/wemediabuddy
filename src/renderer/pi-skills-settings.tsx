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
  const [query, setQuery] = useState('');
  const selected = skills.find((skill) => skill.name === selectedName) ?? null;
  const filteredSkills = skills.filter((skill) => `${skill.name} ${skill.description}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const readOnly = Boolean(selected && !selected.editable);
  const editorState = !selected ? '新建' : selected.editable ? '可编辑' : '只读';
  const editableCount = skills.filter((skill) => skill.editable).length;

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
    <div className="pi-skills-toolbar">
      <div><h3>Skill 清单</h3><p>{skills.length} 个 Skill · {editableCount} 个可编辑</p></div>
      <button type="button" className="secondary-button add" onClick={createNew}>新建 Skill</button>
    </div>
    <div className="pi-skills-layout">
      <aside className="pi-skills-list" aria-label="Skill 清单">
        <label className="pi-skills-search"><span className="sr-only">搜索 Skill</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称或触发描述" /></label>
        <div className="pi-skills-list-scroll">
          {filteredSkills.map((skill) => <button type="button" key={`${skill.scope}:${skill.name}`} className={selectedName === skill.name ? 'selected' : ''} aria-current={selectedName === skill.name ? 'true' : undefined} onClick={() => select(skill)}>
            <span className="pi-skill-list-title"><strong>{skill.name}</strong><em>{skill.editable ? '可编辑' : '只读'}</em></span>
            <small>{skill.description || '暂无触发描述'}</small>
          </button>)}
          {filteredSkills.length === 0 && <p className="pi-skills-empty">没有匹配的 Skill</p>}
        </div>
      </aside>
      <div className={`pi-skill-editor${readOnly ? ' is-readonly' : ''}`}>
        <header className="pi-skill-editor-head">
          <div><h3>{selected?.name || '新建 Skill'}</h3>{readOnly && <p>随来源更新，不能在这里修改。</p>}</div>
          <span className={`pill-status ${readOnly ? 'gray' : 'violet'}`}>{editorState}</span>
        </header>
        <div className="pi-skill-fields">
          <label><span>名称</span><input value={name} readOnly={readOnly} onChange={(event) => setName(event.target.value)} placeholder="lowercase-hyphen-name" /></label>
          <label><span>触发描述</span><textarea rows={3} wrap="soft" value={description} readOnly={readOnly} onChange={(event) => setDescription(event.target.value)} placeholder="说明它做什么，以及哪些表达应触发它。" /></label>
        </div>
        <label className="pi-skill-instructions-field"><span className="pi-skill-field-label">指令 <small>{readOnly ? '可滚动查看全文' : '支持 Markdown'}</small></span><textarea className="pi-skill-instructions" wrap="soft" value={instructions} readOnly={readOnly} onChange={(event) => setInstructions(event.target.value)} placeholder="# 工作流程" /></label>
        <footer className="pi-skill-editor-foot">
          {(note || !readOnly) && <p className="settings-note" aria-live="polite">{note || '保存后，新的 Pi 会话会使用此版本。'}</p>}
          <div className="settings-form-actions">
            {selected?.editable && <button type="button" className="danger-button" onClick={() => void remove()}>删除</button>}
            {(!selected || selected.editable) && <button type="button" className="primary-button" onClick={() => void save()}>保存 Skill</button>}
          </div>
        </footer>
      </div>
    </div>
  </section>;
}

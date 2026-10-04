import { useRef, useState } from 'react';
import { Check, Download, Ellipsis, FolderOpen, LoaderCircle, Music2, Pause, Play, RotateCcw, Trash2, X } from 'lucide-react';
import { isDownloadActive, isDownloadFinished, type DownloadsController, type DownloadTask } from './downloads';
import {ContextMenu, type ContextMenuItem} from './ContextMenu';
import {ToggleSwitch} from './ToggleSwitch';
import {SettingsSelect} from './SettingsSelect';
import {DownloadDeleteDialog} from './DownloadDeleteDialog';
import type {Quality} from './types';
import './downloads.css';

const qualityNames = { '128': '标准', '320': '高品质', flac: '无损' };
const statusNames = { queued: '等待下载', resolving: '正在获取音源', downloading: '正在下载', paused: '已暂停', completed: '已完成', failed: '下载失败', cancelled: '已取消' };

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function DownloadRow({ task, controller, onDelete }: { task: DownloadTask; controller: DownloadsController; onDelete(task: DownloadTask): void }) {
  const [localPending, setPending] = useState(false);
  const pending = localPending || controller.pendingTaskIds.has(task.id);
  const [menu, setMenu] = useState<{x: number; y: number}>();
  const active = isDownloadActive(task);
  const progress = task.totalBytes && task.receivedBytes <= task.totalBytes ? Math.min(99, Math.floor(task.receivedBytes / task.totalBytes * 100)) : undefined;
  const perform = async (action: () => Promise<unknown>) => {
    setPending(true);
    try { await action(); } finally { setPending(false); }
  };
  const menuItems: ContextMenuItem[] = [
    ...(active ? [{id: 'pause', label: '暂停下载', icon: <Pause size={15}/>, onSelect: () => void perform(() => controller.pause(task.id))},
      {id: 'cancel', label: '取消下载', icon: <X size={15}/>, onSelect: () => void perform(() => controller.cancel(task.id))}] : []),
    ...(task.status === 'paused' ? [{id: 'resume', label: '恢复下载（从头开始）', icon: <Play size={15}/>, onSelect: () => void perform(() => controller.resume(task.id))}] : []),
    ...(isDownloadFinished(task) ? [{id: 'redownload', label: '重新下载', icon: <RotateCcw size={15}/>, onSelect: () => void perform(() => controller.redownload(task.id))}] : []),
    ...(task.status === 'completed' ? [{id: 'import', label: task.imported ? '重新导入本地音乐' : '导入本地音乐', icon: <Music2 size={15}/>, onSelect: () => void perform(() => controller.importTrack(task.id))},
      {id: 'directory', label: '打开所在文件夹', icon: <FolderOpen size={15}/>, onSelect: () => void perform(() => controller.openDirectory(task.id))}] : []),
    {id: 'delete', label: '删除下载…', icon: <Trash2 size={15}/>, danger: true, onSelect: () => onDelete(task)},
  ].map(item => ({...item, disabled: pending}));
  return (
    <article className={`download-row download-${task.status}`} aria-label={`${task.track.title}，${statusNames[task.status]}`} aria-busy={pending}
      onContextMenu={event => {event.preventDefault(); if (!pending) setMenu({x: event.clientX, y: event.clientY});}}>
      <div className="download-art" aria-hidden="true">
        {active ? <LoaderCircle className="spin" /> : task.status === 'completed' ? <Check /> : <Music2 />}
      </div>
      <div className="download-info">
        <div className="download-title"><strong>{task.track.title}</strong><span>{qualityNames[task.actualQuality ?? task.quality]}{task.actualQuality && task.actualQuality !== task.quality ? ' · 自动回退' : ''}</span></div>
        <p className="download-artist">{task.track.artist}</p>
        {active && <div className="download-progress" role="progressbar" aria-label={`${task.track.title}下载进度`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
          <span className={progress === undefined ? 'indeterminate' : ''} style={progress === undefined ? undefined : { width: `${progress}%` }} />
        </div>}
        <p className={`download-detail ${task.status === 'failed' ? 'download-error' : ''}`} title={task.error ?? task.fileName}>
          {task.status === 'failed' ? task.error || '网络异常，请重试' : statusNames[task.status]}
          {task.receivedBytes > 0 && <> · {bytes(task.receivedBytes)}{active && task.totalBytes ? ` / ${bytes(task.totalBytes)}` : ''}</>}
          {active && progress !== undefined ? ` · ${progress}%` : ''}
          {task.status === 'completed' && task.fileName ? ` · ${task.fileName}` : ''}
          {task.status === 'paused' ? ' · 恢复时从头下载' : ''}
        </p>
        {task.status === 'completed' && (task.coverFileName || task.lyricsFileName) && <p className="download-attachments">{[task.coverFileName && '封面已保存', task.lyricsFileName && '歌词已保存'].filter(Boolean).join(' · ')}</p>}
        {!!task.attachmentWarnings?.length && <p className="download-attachment-warning" role="status">{task.attachmentWarnings.join('；')}</p>}
      </div>
      <div className="download-actions">
        {active && <button type="button" className="download-action" aria-label={`暂停下载 ${task.track.title}`} disabled={pending} onClick={() => void perform(() => controller.pause(task.id))}><Pause size={15}/>暂停</button>}
        {active && <button type="button" className="icon-button" title="取消下载" aria-label={`取消下载 ${task.track.title}`} disabled={pending} onClick={() => void perform(() => controller.cancel(task.id))}><X size={18}/></button>}
        {task.status === 'paused' && <button type="button" className="download-action" title="重新获取音源并从头下载" aria-label={`恢复下载 ${task.track.title}`} disabled={pending} onClick={() => void perform(() => controller.resume(task.id))}><Play size={15}/>恢复下载</button>}
        {isDownloadFinished(task) && <button type="button" className="download-action" disabled={pending} title="创建新任务，保留已有文件" onClick={() => void perform(() => controller.redownload(task.id))}><RotateCcw size={15} />重新下载</button>}
        {task.status === 'completed' && <>
          <button type="button" className="download-action" disabled={pending} onClick={() => void perform(() => controller.importTrack(task.id))}><Music2 size={15} />{task.imported ? '重新导入' : '导入本地音乐'}</button>
          <button type="button" className="icon-button" title="打开所在文件夹" aria-label={`打开 ${task.track.title} 所在文件夹`} disabled={pending} onClick={() => void perform(() => controller.openDirectory(task.id))}><FolderOpen size={18} /></button>
        </>}
        <button type="button" className="icon-button" title="删除下载" aria-label={`删除下载 ${task.track.title}`} disabled={pending} onClick={() => onDelete(task)}><Trash2 size={17}/></button>
        <button type="button" className="icon-button" title="更多下载操作" aria-label={`更多下载操作 ${task.track.title}`} disabled={pending} aria-haspopup="menu" aria-expanded={!!menu}
          onClick={event => {const bounds = event.currentTarget.getBoundingClientRect(); setMenu({x: bounds.right - 160, y: bounds.bottom + 5});}}><Ellipsis size={19}/></button>
      </div>
      {menu && <ContextMenu ariaLabel={`${task.track.title}下载操作`} position={menu} onClose={() => setMenu(undefined)} items={menuItems}/>}
    </article>
  );
}

export function DownloadSettings({ controller }: { controller: DownloadsController }) {
  const [changingDirectory, setChangingDirectory] = useState(false);
  return <section className="settings-card download-settings" aria-label="下载设置">
    <div className="section-heading"><Download size={20}/><h2>下载设置</h2></div>
    <label className="setting-row download-quality-row"><span>默认下载音质<small>单独保存，不随在线播放音质改变。</small></span>
      <SettingsSelect label="默认下载音质" value={controller.downloadQuality} onChange={value => controller.setDownloadQuality(value as Quality)}
        options={[{value: '128', label: '标准 · 128 kbps'}, {value: '320', label: '高清 · 320 kbps'}, {value: 'flac', label: '无损 · FLAC'}]}/></label>
    <div className="setting-row download-option-row"><span>下载封面<small>保存歌曲封面图片，方便离线查看。</small></span><ToggleSwitch label="下载时同时下载封面" checked={controller.downloadCover} onCheckedChange={controller.setDownloadCover}/></div>
    <div className="setting-row download-option-row"><span>下载歌词<small>保存同名 LRC 歌词文件。</small></span><ToggleSwitch label="下载时同时下载歌词" checked={controller.downloadLyrics} onCheckedChange={controller.setDownloadLyrics}/></div>
    <div className="download-directory">
      <FolderOpen size={18} aria-hidden="true" />
      <div><span>下载文件位置</span><p title={controller.directory}>{controller.directory || '尚未选择下载文件夹'}</p></div>
      <button type="button" className="download-action" disabled={changingDirectory} onClick={async () => {
        setChangingDirectory(true);
        try { await controller.selectDirectory(); } finally { setChangingDirectory(false); }
      }}>{changingDirectory ? '选择中…' : '更改文件夹'}</button>
      <button type="button" className="icon-button" title="打开下载文件夹" aria-label="打开下载文件夹" disabled={!controller.directory} onClick={() => void controller.openDirectory()}><FolderOpen size={18} /></button>
    </div>
    <p className="setting-help">新任务使用以上默认选项；重新下载保留原任务的音质与附件选项，并创建新文件。</p>
    {controller.error && <p className="download-operation-error" role="alert">{controller.error}</p>}
  </section>;
}

export default function DownloadManagerView({ controller }: { controller: DownloadsController }) {
  const [deleteTask, setDeleteTask] = useState<DownloadTask>();
  const [deletePending, setDeletePending] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const deleting = useRef(false);
  const [clearing, setClearing] = useState(false);
  const activeCount = controller.tasks.filter(isDownloadActive).length;
  const pausedCount = controller.tasks.filter(task => task.status === 'paused').length;
  const completedCount = controller.tasks.filter(task => task.status === 'completed').length;
  const remove = async (deleteFiles: boolean) => {
    if (!deleteTask || deleting.current) return;
    deleting.current = true;
    setDeletePending(true);
    setDeleteError('');
    try {
      const result = await controller.removeTask(deleteTask.id, deleteFiles);
      if (result) setDeleteTask(undefined);
      else setDeleteError('删除未完成，请重试。');
    } catch (reason) {setDeleteError(reason instanceof Error ? reason.message : '删除未完成，请重试。');}
    finally {deleting.current = false; setDeletePending(false);}
  };
  return (
    <section className="downloads-page" aria-label="下载管理">
      <div className="downloads-heading">
        <div><h1 data-downloads-title tabIndex={-1}>下载管理</h1><p>{activeCount} 首下载中 · {pausedCount} 首已暂停 · {completedCount} 首已完成</p></div>
        <button type="button" className="download-action" disabled={clearing || !controller.tasks.some(isDownloadFinished)} onClick={async () => {setClearing(true); try {await controller.clearHistory();} finally {setClearing(false);}}} title="清除已完成、失败和取消的记录，保留正在下载、暂停的任务及音乐文件"><Trash2 size={15} />{clearing ? '正在清除…' : '清除下载记录'}</button>
      </div>
      {controller.error && !deleteTask && <p className="download-operation-error" role="alert">{controller.error}</p>}
      {controller.loading ? <div className="downloads-empty"><LoaderCircle className="spin" /><p>正在读取下载列表…</p></div> : !controller.tasks.length ? (
        <div className="downloads-empty"><Download size={32} /><h2>把喜欢的音乐保存下来</h2><p>在在线歌曲列表或播放条点击下载，即可离线收藏。</p><p>下载音质、封面和歌词可在「设置 · 下载设置」中单独调整。</p></div>
      ) : <div className="download-list">{controller.tasks.map(task => <DownloadRow key={task.id} task={task} controller={controller} onDelete={selected => {controller.clearError(); setDeleteError(''); setDeleteTask(selected);}}/>)}</div>}
      {deleteTask && <DownloadDeleteDialog task={controller.tasks.find(task => task.id === deleteTask.id) ?? deleteTask} pending={deletePending} error={controller.error || deleteError} onChoose={choice => void remove(choice)} onClose={() => {if (!deleting.current) setDeleteTask(undefined);}}/>}
    </section>
  );
}

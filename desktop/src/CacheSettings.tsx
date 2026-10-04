import {useEffect, useState} from 'react';
import {Database, Trash2} from 'lucide-react';
import {clearDiscoveryCache, getDiscoveryCacheStats, subscribeDiscoveryCache} from './services/discoveryCache';
import './cache-settings.css';

function cacheSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.ceil(bytes / 1024)} KB`;
}

export function CacheSettings() {
  const [stats, setStats] = useState(getDiscoveryCacheStats);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const update = () => setStats(getDiscoveryCacheStats());
    const unsubscribe = subscribeDiscoveryCache(update);
    update();
    return unsubscribe;
  }, []);

  function clear() {
    setMessage('');
    setError('');
    try {
      clearDiscoveryCache();
      setMessage('浏览缓存已清除，下次打开榜单或歌单时会重新获取。');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '缓存清理失败，请稍后重试。');
    }
  }

  return <section className="settings-card cache-settings" aria-label="缓存设置">
    <div className="section-heading"><Database size={20}/><h2>浏览缓存</h2></div>
    <p className="setting-help">暂存榜单与歌单信息，减少重复加载。内容会定期更新。</p>
    <div className="cache-settings-summary">
      <div><span>已缓存的榜单与歌单</span><strong>{stats.entries} 项 <small>· {cacheSize(stats.bytes)}</small></strong></div>
      <button type="button" className="secondary-button" onClick={clear}><Trash2 size={15}/>清除浏览缓存</button>
    </div>
    <p className="setting-help">仅清理接口浏览数据，收藏、自建歌单、下载文件和背景设置都会保留。</p>
    {message && <p className="cache-settings-message" role="status">{message}</p>}
    {error && <p className="cache-settings-error" role="alert">{error}</p>}
  </section>;
}

export default CacheSettings;

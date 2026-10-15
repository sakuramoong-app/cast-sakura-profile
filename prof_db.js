/* ============================================================
   prof_db.js — キャストプロフ：Supabase とのやりとり（内勤・キャスト共通）
   ------------------------------------------------------------
   今までの GAS と同じ「_type / action 名・返事の形」のまま、中身だけ Supabase にした。
   画面は fetch(GAS_URL…) のかわりに profFetch(GAS_URL…) を呼ぶだけ（返事の読み方は同じ）。

   ・内勤（staff.html）：ポータルのログイン（naikin@…・20時間）をそのまま使う
   ・キャスト（index.html）：ログインなし。提出（prof_submit）だけできる
   ・提出されたら、通知先メールあてにメールが届く（Supabase 側で順番待ちに入れる）
   ============================================================ */
(function(){
  const SUPABASE_URL = "https://tuxqpqokbvkrckgxcfdn.supabase.co";
  const SUPABASE_KEY = "sb_publishable_PyvCZHSzYlaqauYbdZybng_zbftghak";
  const STAFF_EMAIL = 'naikin@sakuramoong.internal';
  const STAFF_HOURS = 20;

  const ROLE = (window.PROF_DB_ROLE === 'cast') ? 'cast' : 'staff';
  const sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY, ROLE === 'cast'
    ? { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false, storageKey: 'sakura-prof-cast' } }
    : { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } });

  /* ---------- 内勤のログインの確かめ ---------- */
  function jwtPayload(s){
    try{
      const p = s.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/');
      return JSON.parse(decodeURIComponent(escape(atob(p))));
    }catch(e){ return {}; }
  }
  function sessionExpiresAt(s){
    let t = 0;
    (jwtPayload(s).amr || []).forEach(a=>{ if(a && Number(a.timestamp) > t) t = Number(a.timestamp); });
    return t ? (t + STAFF_HOURS * 3600) * 1000 : 0;
  }
  async function getStaffSession(){
    try{
      const { data } = await sb.auth.getSession();
      const s = data && data.session;
      if(!s || !s.user || String(s.user.email || '').toLowerCase() !== STAFF_EMAIL) return null;
      return Date.now() < sessionExpiresAt(s) ? s : null;
    }catch(e){ return null; }
  }

  /* ---------- 共通 ---------- */
  function q(res){ if(res.error) throw res.error; return res.data; }
  const str = (v)=> v == null ? '' : String(v);
  const now = ()=> new Date().toISOString();
  const ok = (o)=> Object.assign({ result: 'ok', serverTime: now() }, o || {});

  async function selectAll(table, cols, order){
    const out = [];
    for(let from = 0; ; from += 1000){
      const rows = q(await sb.from(table).select(cols).order(order).range(from, from + 999));
      out.push.apply(out, rows || []);
      if(!rows || rows.length < 1000) break;
    }
    return out;
  }
  async function getSetting(key){
    const r = q(await sb.from('prof_settings').select('value').eq('key', key).maybeSingle());
    return (r && Array.isArray(r.value)) ? r.value : [];
  }
  async function setSetting(key, list){
    q(await sb.from('prof_settings').upsert({ key, value: list }));
  }
  async function addToSetting(key, value){
    const v = str(value).trim();
    if(!v) return;
    const list = await getSetting(key);
    if(list.indexOf(v) < 0){ list.push(v); await setSetting(key, list); }
  }

  // 画面が受け取る形（今の GAS の getCasts と同じ）
  function castOut(r, i){
    const d = r.data || {};
    const hp = d.hotelPrefs || {};
    return Object.assign({}, d, {
      id: r.id, name: d.name != null ? d.name : r.name,
      vibes: Array.isArray(d.vibes) ? d.vibes : (d.vibes ? String(d.vibes).split('・') : []),
      options: d.options || {}, optMemo: d.optMemo || {},
      status: d.status || 'new',
      generatedCastComment: d.generatedCastComment || '', generatedManagerComment: d.generatedManagerComment || '',
      backData: d.backData || {}, honshimei: d.honshimei || {}, storeProfiles: d.storeProfiles || {},
      interviewDate: d.interviewDate || '', joinDate: d.joinDate || '', leaveDate: d.leaveDate || '',
      joinReason: d.joinReason || '', leaveReason: d.leaveReason || '',
      retired: d.retired === true || d.retired === 'TRUE',
      updatedAt: d.updatedAt || '',
      hotelPrefs: { ok: hp.ok || [], ng: hp.ng || [], conditional: hp.conditional || [], memo: hp.memo || {} },
      personalityType: d.personalityType || '',
      personalityAnswers: d.personalityAnswers || { list: [], axisSummary: [] },
      colorIdx: i % 8
    });
  }

  /* ---------- 読み取り（GET の action） ---------- */
  const GET = {
    async getCasts(){
      const rows = await selectAll('prof_casts', 'id,name,deleted,data,seq', 'seq');
      const casts = [];
      rows.forEach((r, i)=>{ if(!r.deleted) casts.push(castOut(r, i)); });
      return ok({ casts });
    },
    async getLogs(){
      const rows = await selectAll('prof_logs', '*', 'created_at');
      return ok({ logs: rows.map(r=>({ logId: r.log_id, castId: r.cast_id, castName: r.cast_name, type: r.type,
        date: r.date, reservationDate: r.reservation_date, content: r.content, createdAt: r.created_at, author: r.author || '' })) });
    },
    async getHotels(){
      const rows = await selectAll('prof_hotels', '*', 'seq');
      return ok({ hotels: rows.map(r=>({ hotelId: r.hotel_id, area: r.area, hotelName: r.hotel_name,
        tags: Array.isArray(r.tags) ? r.tags : [], storeStatus: r.store_status || '', note: r.note, mapUrl: r.map_url, createdAt: r.created_at })) });
    },
    async getHotelMeta(){
      const [areas, tags] = await Promise.all([getSetting('hotelAreas'), getSetting('hotelTags')]);
      return ok({ areas, tags });
    },
    async getNotifySettings(){ return ok({ emails: await getSetting('notifyEmails') }); },
    async getSubmissions(){ return ok({ submissions: [] }); },
  };

  /* ---------- 書きこみ（POST の _type） ---------- */
  const POST = {
    // だれが直したかを履歴に残すため、ポータルで選んでいる担当者を一緒に送る
    async updateConfirmed(d){
      let by = '';
      try{ by = localStorage.getItem('currentOperator') || ''; }catch(e){}
      return q(await sb.rpc('prof_update_confirmed', { p: Object.assign({}, d, { by }) }));
    },

    // 変更の履歴（そのキャストの分。新しい順）
    async getHistory(d){
      const rows = q(await sb.from('prof_history').select('path,before,after,by_name,source,at')
        .eq('cast_id', str(d.castId)).order('at', { ascending: false }).order('id', { ascending: false }).limit(300));
      return { result: 'ok', history: rows || [] };
    },

    async delete(d){
      let rows = q(await sb.from('prof_casts').update({ deleted: true }).eq('id', str(d.id)).select('id'));
      if(!rows || !rows.length) q(await sb.from('prof_casts').update({ deleted: true }).eq('name', str(d.name)).eq('deleted', false));
      return { result: 'ok', action: 'deleted', id: d.id };
    },

    async addLog(d){
      const logId = 'LOG-' + (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));
      const row = q(await sb.from('prof_logs').insert({ log_id: logId, cast_id: str(d.castId), cast_name: str(d.castName),
        type: str(d.logType), date: str(d.date), reservation_date: str(d.reservationDate), content: str(d.content),
        author: str(d.author).slice(0, 20) })
        .select('created_at').single());
      return { result: 'ok', action: 'logAdded', logId, createdAt: row.created_at };
    },

    // 記録の編集（内容・書いた内勤）と削除
    async updateLog(d){
      const u = {};
      if(d.content !== undefined) u.content = str(d.content).slice(0, 10000);
      if(d.author !== undefined) u.author = str(d.author).slice(0, 20);
      const rows = q(await sb.from('prof_logs').update(u).eq('log_id', str(d.logId)).select('log_id'));
      return rows && rows.length ? { result: 'ok', action: 'logUpdated', logId: d.logId } : { result: 'error', message: '記録が見つかりません' };
    },
    async deleteLog(d){
      q(await sb.from('prof_logs').delete().eq('log_id', str(d.logId)));
      return { result: 'ok', action: 'logDeleted', logId: d.logId };
    },

    async addHotel(d){
      const hotelId = str(d.hotelId) || ('H-' + Date.now());
      const row = q(await sb.from('prof_hotels').insert({ hotel_id: hotelId, area: str(d.area), hotel_name: str(d.hotelName),
        tags: Array.isArray(d.tags) ? d.tags : [], store_status: str(d.storeStatus), note: str(d.note), map_url: str(d.mapUrl) })
        .select('created_at').single());
      // 使われたエリア名・タグは「よく使う語彙」にも登録しておく（今の GAS と同じ）
      await addToSetting('hotelAreas', d.area);
      for(const t of (d.tags || [])) await addToSetting('hotelTags', t);
      return { result: 'ok', action: 'hotelAdded', hotelId, createdAt: row.created_at };
    },

    async updateHotel(d){
      const u = {};
      if(d.area !== undefined) u.area = str(d.area);
      if(d.hotelName !== undefined) u.hotel_name = str(d.hotelName);
      if(d.tags !== undefined) u.tags = Array.isArray(d.tags) ? d.tags : [];
      if(d.storeStatus !== undefined) u.store_status = str(d.storeStatus);
      if(d.note !== undefined) u.note = str(d.note);
      if(d.mapUrl !== undefined) u.map_url = str(d.mapUrl);
      if(Object.keys(u).length) q(await sb.from('prof_hotels').update(u).eq('hotel_id', str(d.hotelId)));
      if(d.area !== undefined) await addToSetting('hotelAreas', d.area);
      if(d.tags !== undefined) for(const t of (d.tags || [])) await addToSetting('hotelTags', t);
      return { result: 'ok', action: 'hotelUpdated', hotelId: d.hotelId };
    },

    async deleteHotel(d){
      q(await sb.from('prof_hotels').delete().eq('hotel_id', str(d.hotelId)));
      return { result: 'ok', action: 'hotelDeleted', hotelId: d.hotelId };
    },

    async addHotelMeta(d){
      await addToSetting(d.kind === 'area' ? 'hotelAreas' : 'hotelTags', d.value);
      return { result: 'ok', action: 'metaAdded', kind: d.kind, value: d.value };
    },
    async deleteHotelMeta(d){
      const key = d.kind === 'area' ? 'hotelAreas' : 'hotelTags';
      await setSetting(key, (await getSetting(key)).filter(v=>v !== d.value));
      return { result: 'ok', action: 'metaDeleted', kind: d.kind, value: d.value };
    },

    async addNotifyEmail(d){
      await addToSetting('notifyEmails', d.email);
      return { result: 'ok', action: 'notifyEmailAdded', email: d.email };
    },
    async deleteNotifyEmail(d){
      await setSetting('notifyEmails', (await getSetting('notifyEmails')).filter(v=>v !== d.email));
      return { result: 'ok', action: 'notifyEmailDeleted', email: d.email };
    },

    // 生成したプロフの送信（今の GAS でも保存先がなく使われていない）：何もしない
    async prof_generated(){ return { result: 'ok' }; },
  };

  // キャストの提出（_type なし）
  async function submit(d){
    const p = Object.assign({}, d); delete p._type; delete p._token;
    return q(await sb.rpc('prof_submit', { p }));
  }

  /* ---------- 入口：fetch と同じ形で返す ---------- */
  function readBody(opts){
    const b = opts && opts.body;
    if(!b) return null;
    try{
      if(typeof FormData !== 'undefined' && b instanceof FormData) return JSON.parse(b.get('payload') || '{}');
      if(typeof b === 'string') return JSON.parse(b);
    }catch(e){}
    return {};
  }
  async function run(url, opts){
    const body = readBody(opts);
    if(ROLE === 'cast'){
      if(body && !body._type) return submit(body);
      return { result: 'error', message: '認証エラー' };
    }
    const sess = await getStaffSession();
    try{
      if(body){
        const t = body._type || '';
        if(t === 'ssoLogin' || t === 'login') return { result: 'error', message: 'ポータルから開き直してください' };
        if(!t) return submit(body);
        if(!POST[t]) return { result: 'error', message: '不明な操作です' };
        if(!sess) return { result: 'error', message: '認証エラー' };
        return await POST[t](body);
      }
      let action = '';
      try{ action = new URL(url, location.href).searchParams.get('action') || ''; }catch(e){}
      if(!action) return { result: 'ok', message: 'プロフ 動作確認OK ✅' };
      if(!sess) return { result: 'error', message: '認証エラー' };
      if(!GET[action]) return { result: 'error', message: '不明な操作です' };
      return await GET[action]();
    }catch(e){
      const code = String((e && e.code) || '');
      if(code === '42501' || code === 'PGRST301' || code === 'PGRST303' || (e && (e.status === 401 || e.status === 403))) return { result: 'error', message: '認証エラー' };
      throw e;
    }
  }
  async function profFetch(url, opts){
    const data = await run(url, opts);
    return { ok: true, status: 200, json: async ()=>data, text: async ()=>JSON.stringify(data) };
  }

  window.profFetch = profFetch;
  window.ProfDB = { getStaffSession, sessionExpiresAt, client: sb };
})();

/**
 * panels.js — Sidebar navigation, email panels, calendar, CRM, conversations, connections.
 * Depends on: api.js (AtomAPI), chat.js (esc, conversationId, updateSidebarFooter)
 */

// ── Sidebar ────────────────────────────────────────────────────────────────

let currentPanel = 'chat';

function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('open');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
}

function toggleMenu() { openSidebar(); }

function showPanel(name) {
    document.querySelectorAll('.panel-view').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

    const panel = document.getElementById('panel-' + name);
    if (panel) panel.classList.add('active');

    const navEl = document.getElementById('nav-' + name);
    if (navEl) navEl.classList.add('active');

    currentPanel = name;
    closeSidebar();

    if (name === 'inbox')         loadInbox();
    if (name === 'sent')          loadSent();
    if (name === 'conversations') loadConversations();
    if (name === 'connections')   loadConnections();
    if (name === 'crm-jobs')      loadCrmJobs();
    if (name === 'knowledge')     loadKnowledgeBase();
    if (name === 'crm-contacts')  loadCrmContacts();
    if (name === 'today')         loadTodayEvents();
    if (name === 'calview')       loadCalendarView();
}

// ── Inbox ──────────────────────────────────────────────────────────────────

async function loadInbox() {
    const body = document.getElementById('inboxBody');
    const s    = AtomAPI.state(body);
    s.loading('Loading inbox…');
    try {
        const data   = await AtomAPI.get('/integrations/email/read');
        const emails = data.emails || data.messages || data || [];
        if (!Array.isArray(emails) || emails.length === 0) {
            s.empty('No emails found. Make sure Gmail is connected in Settings.');
            return;
        }
        body.innerHTML = emails.map(e => `
            <div class="email-card ${e.unread ? 'unread' : ''}">
                <div class="email-row1">
                    <span class="email-from">${esc(e.from || e.sender || 'Unknown')}</span>
                    <span class="email-time">${esc(e.date || e.timestamp || '')}</span>
                </div>
                <div class="email-subject">${esc(e.subject || '(no subject)')}</div>
                <div class="email-preview">${esc(e.snippet || e.preview || e.body?.substring(0, 120) || '')}</div>
            </div>`).join('');
    } catch (err) {
        s.error(`Failed to load inbox: ${esc(err.message)}<br><br>Make sure Gmail is connected in ⚙️ Settings.`);
    }
}

// ── Sent ───────────────────────────────────────────────────────────────────

async function loadSent() {
    const body = document.getElementById('sentBody');
    const s    = AtomAPI.state(body);
    s.loading('Loading sent mail…');
    try {
        const data   = await AtomAPI.get('/integrations/email/sent');
        const emails = data.emails || data.messages || data || [];
        if (!Array.isArray(emails) || emails.length === 0) {
            s.empty('No sent mail found.');
            return;
        }
        body.innerHTML = emails.map(e => `
            <div class="email-card">
                <div class="email-row1">
                    <span class="email-from">To: ${esc(e.to || e.recipient || '?')}</span>
                    <span class="email-time">${esc(e.date || e.timestamp || '')}</span>
                </div>
                <div class="email-subject">${esc(e.subject || '(no subject)')}</div>
                <div class="email-preview">${esc(e.snippet || e.preview || e.body?.substring(0, 120) || '')}</div>
            </div>`).join('');
    } catch (err) {
        s.error(`Could not load sent mail: ${esc(err.message)}`);
    }
}

// ── Compose ────────────────────────────────────────────────────────────────

async function sendComposedEmail() {
    const to      = document.getElementById('composeTo').value.trim();
    const subject = document.getElementById('composeSubject').value.trim();
    const body    = document.getElementById('composeBody').value.trim();
    const btn     = document.getElementById('composeSendBtn');

    if (!to || !subject || !body) {
        showComposeStatus('Please fill in To, Subject, and Message.', 'err');
        return;
    }
    if (!AtomAPI.confirm(`Send email to ${to}?`)) return;

    const restore = AtomAPI.withButton(btn, '⏳ Sending…');
    showComposeStatus('', '');
    try {
        const data = await AtomAPI.post('/integrations/email/send', { to, subject, body });
        showComposeStatus('✅ Email sent successfully!', 'ok');
        document.getElementById('composeTo').value      = '';
        document.getElementById('composeSubject').value = '';
        document.getElementById('composeBody').value    = '';
    } catch (err) {
        showComposeStatus('❌ Error: ' + (err.message || 'Send failed'), 'err');
    } finally {
        restore();
    }
}

function showComposeStatus(msg, cls) {
    const el = document.getElementById('composeStatus');
    if (!el) return;
    el.textContent     = msg;
    el.className       = 'panel-msg ' + cls;
    el.style.display   = msg ? 'block' : 'none';
}

// ── Calendar: Today ────────────────────────────────────────────────────────

async function loadTodayEvents() {
    const body = document.getElementById('todayBody');
    const s    = AtomAPI.state(body);
    s.loading("Loading today's events…");
    try {
        const data   = await AtomAPI.get('/integrations/calendar/today');
        const events = data.events || data || [];
        if (!Array.isArray(events) || events.length === 0) {
            const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
            body.innerHTML = `<p class="panel-msg">No events found for ${today}.</p>
                <div class="placeholder-card" style="margin-top:1rem;">
                    <div class="placeholder-text">Connect Google Calendar in ⚙️ Settings to see your schedule.</div>
                </div>`;
            return;
        }
        body.innerHTML = events.map(e => `
            <div class="cal-event">
                <div class="cal-event-time">${esc(e.startTime || e.time || '')}</div>
                <div>
                    <div class="cal-event-title">${esc(e.title || e.summary || 'Event')}</div>
                    ${e.location ? `<div class="cal-event-loc">📍 ${esc(e.location)}</div>` : ''}
                </div>
            </div>`).join('');
    } catch (err) {
        body.innerHTML = `<div class="placeholder-card"><div class="placeholder-text">Calendar not yet connected.<br><br>Connect Google Calendar in ⚙️ Settings.</div></div>`;
    }
}

// ── Calendar: View ─────────────────────────────────────────────────────────

async function loadCalendarView() {
    const body = document.getElementById('calviewBody');
    const s    = AtomAPI.state(body);
    s.loading('Loading calendar…');
    try {
        const data   = await AtomAPI.get('/integrations/calendar/upcoming');
        const events = data.events || data || [];
        if (!Array.isArray(events) || events.length === 0) {
            s.empty('No upcoming events.');
            return;
        }
        body.innerHTML = events.map(e => `
            <div class="cal-event">
                <div class="cal-event-time">${esc(e.startTime || e.time || e.date || '')}</div>
                <div>
                    <div class="cal-event-title">${esc(e.title || e.summary || 'Event')}</div>
                    ${e.location ? `<div class="cal-event-loc">📍 ${esc(e.location)}</div>` : ''}
                </div>
            </div>`).join('');
    } catch (err) {
        body.innerHTML = `<div class="placeholder-card"><div class="placeholder-text">Could not load calendar: ${esc(err.message)}</div></div>`;
    }
}

// ── Calendar: New Event ────────────────────────────────────────────────────

async function saveCalendarEvent() {
    const status = document.getElementById('eventStatus');
    const btn    = document.getElementById('eventSaveBtn');
    const title  = document.getElementById('eventTitle').value.trim();
    const date   = document.getElementById('eventDate').value;
    const time   = document.getElementById('eventTime').value;
    const dur    = parseInt(document.getElementById('eventDuration').value) || 60;
    const desc   = document.getElementById('eventDesc').value.trim();

    if (!title || !date || !time) {
        status.textContent = 'Title, date, and time are required.';
        status.className   = 'panel-msg err';
        status.style.display = 'block';
        return;
    }

    const start = new Date(`${date}T${time}:00`);
    const end   = new Date(start.getTime() + dur * 60000);

    const restore = AtomAPI.withButton(btn, '⏳ Saving…');
    status.style.display = 'none';
    try {
        const data = await AtomAPI.post('/integrations/calendar/events', {
            title, description: desc,
            startTime: start.toISOString(),
            endTime:   end.toISOString(),
        });
        status.textContent   = '✅ Event created!';
        status.className     = 'panel-msg ok';
        status.style.display = 'block';
        document.getElementById('eventTitle').value       = '';
        document.getElementById('eventDate').value        = '';
        document.getElementById('eventTime').value        = '';
        document.getElementById('eventDuration').value    = '60';
        document.getElementById('eventDesc').value        = '';
    } catch (err) {
        status.textContent   = '❌ ' + (err.message || 'Save failed');
        status.className     = 'panel-msg err';
        status.style.display = 'block';
    } finally {
        restore();
    }
}

// ── CRM: Jobs ──────────────────────────────────────────────────────────────

async function loadCrmJobs() {
    const body   = document.getElementById('crmJobsBody');
    const search = document.getElementById('crmJobSearch')?.value?.trim() || '';
    const s      = AtomAPI.state(body);
    s.loading('Loading jobs…');
    try {
        const url  = '/integrations/crm/jobs' + (search ? `?search=${encodeURIComponent(search)}` : '');
        const data = await AtomAPI.get(url);
        const jobs = data.jobs || data || [];
        if (!Array.isArray(jobs) || jobs.length === 0) {
            s.empty(search ? `No jobs matching "${esc(search)}"` : 'No jobs found in AccuLynx.');
            return;
        }
        body.innerHTML = jobs.map(j => `
            <div class="crm-card">
                <div class="crm-title">${esc(j.name || j.jobName || j.title || 'Job')}</div>
                <div class="crm-sub">${esc(j.customer?.name || j.customerName || '')}${j.address ? ' · ' + esc(j.address) : ''}</div>
                ${j.status ? `<span class="crm-badge">${esc(j.status)}</span>` : ''}
            </div>`).join('');
    } catch (err) {
        s.error('Could not load CRM jobs: ' + esc(err.message));
    }
}

// ── CRM: Contacts ──────────────────────────────────────────────────────────

async function loadCrmContacts() {
    const body   = document.getElementById('crmContactsBody');
    const search = document.getElementById('crmContactSearch')?.value?.trim() || '';
    const s      = AtomAPI.state(body);
    s.loading('Loading contacts…');
    try {
        const url  = '/integrations/crm/contacts' + (search ? `?search=${encodeURIComponent(search)}` : '');
        const data = await AtomAPI.get(url);
        const contacts = data.contacts || data || [];
        if (!Array.isArray(contacts) || contacts.length === 0) {
            s.empty(search ? `No contacts matching "${esc(search)}"` : 'No contacts found.');
            return;
        }
        body.innerHTML = contacts.map(c => `
            <div class="crm-card">
                <div class="crm-title">${esc(c.name || c.firstName + ' ' + c.lastName || 'Contact')}</div>
                ${c.email ? `<div class="crm-sub">${esc(c.email)}</div>` : ''}
                ${c.phone ? `<div class="crm-sub">${esc(c.phone)}</div>` : ''}
            </div>`).join('');
    } catch (err) {
        s.error('Could not load contacts: ' + esc(err.message));
    }
}

// ── CRM: Create Lead ───────────────────────────────────────────────────────

async function createCrmLead() {
    const status = document.getElementById('leadStatus');
    const btn    = document.getElementById('leadSaveBtn');
    const name   = document.getElementById('leadName').value.trim();
    const email  = document.getElementById('leadEmail').value.trim();
    const phone  = document.getElementById('leadPhone').value.trim();
    const addr   = document.getElementById('leadAddress').value.trim();
    const notes  = document.getElementById('leadNotes').value.trim();

    if (!name) {
        status.textContent   = 'Customer name is required.';
        status.className     = 'panel-msg err';
        status.style.display = 'block';
        return;
    }
    if (!AtomAPI.confirm(`Create lead for "${name}"?`)) return;

    const restore = AtomAPI.withButton(btn, '⏳ Saving…');
    status.style.display = 'none';
    try {
        const data = await AtomAPI.post('/integrations/crm/leads', { name, email, phone, address: addr, notes });
        status.textContent   = `✅ Lead created: ${esc(data.jobName || name)}`;
        status.className     = 'panel-msg ok';
        status.style.display = 'block';
        ['leadName', 'leadEmail', 'leadPhone', 'leadAddress', 'leadNotes'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
    } catch (err) {
        status.textContent   = '❌ ' + (err.message || 'Create failed');
        status.className     = 'panel-msg err';
        status.style.display = 'block';
    } finally {
        restore();
    }
}

// ── Knowledge Base ─────────────────────────────────────────────────────────

let kbActiveCat = null;

function switchKbTab(tab) {
    document.getElementById('kbTabTextBody').style.display = tab === 'text' ? '' : 'none';
    document.getElementById('kbTabFileBody').style.display = tab === 'file' ? '' : 'none';
    const textBtn = document.getElementById('kbTabText');
    const fileBtn = document.getElementById('kbTabFile');
    if (textBtn) { textBtn.style.background = tab === 'text' ? 'rgba(34,197,94,0.18)' : 'transparent'; textBtn.style.color = tab === 'text' ? '#00d4dc' : '#94a3b8'; }
    if (fileBtn) { fileBtn.style.background = tab === 'file' ? 'rgba(34,197,94,0.18)' : 'transparent'; fileBtn.style.color = tab === 'file' ? '#00d4dc' : '#94a3b8'; }
}

async function loadKnowledgeBase() {
    const body   = document.getElementById('kbBody');
    const search = document.getElementById('kbSearchInput')?.value?.trim() || '';
    const s      = AtomAPI.state(body);
    s.loading('Loading…');

    // Load categories
    try {
        const catData = await AtomAPI.get('/knowledge-base/categories');
        const cats    = catData.categories || [];
        const chips   = document.getElementById('kbCategoryChips');
        if (chips) {
            chips.innerHTML = ['All', ...cats].map(cat => {
                const active = (cat === 'All' && !kbActiveCat) || cat === kbActiveCat;
                return `<button onclick="setKbCategory('${cat === 'All' ? '' : cat}')"
                    style="padding:0.2rem 0.55rem;font-size:0.73rem;border-radius:99px;border:1px solid ${active ? '#00d4dc' : 'rgba(255,255,255,0.12)'};background:${active ? 'rgba(34,197,94,0.18)' : 'transparent'};color:${active ? '#00d4dc' : '#94a3b8'};cursor:pointer;font-family:inherit;">${esc(cat)}</button>`;
            }).join('');
        }
    } catch {}

    try {
        const params = new URLSearchParams({ page: '1', pageSize: '30' });
        if (search)      params.set('search', search);
        if (kbActiveCat) params.set('category', kbActiveCat);

        const data    = await AtomAPI.get(`/knowledge-base?${params}`);
        const entries = data.entries || [];
        const total   = data.total ?? entries.length;

        if (!entries.length) {
            body.innerHTML = `<div class="placeholder-card">
                <div class="placeholder-icon">🧠</div>
                <div class="placeholder-text">${search ? 'No entries matched "' + esc(search) + '".' : 'Your knowledge base is empty.'}<br><br>
                Click <strong>+ Add</strong> to add company info, SOPs, or product details.</div>
            </div>`;
            return;
        }

        body.innerHTML = `<div style="font-size:0.73rem;color:#64748b;margin-bottom:0.5rem;">${total} entr${total === 1 ? 'y' : 'ies'}</div>` +
            entries.map(e => `
            <div onclick="viewKbEntry('${esc(e.id)}', ${JSON.stringify(esc(e.title)).replace(/"/g, "'")})"
                 style="border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:0.65rem 0.85rem;margin-bottom:0.45rem;background:rgba(255,255,255,0.03);cursor:pointer;"
                 onmouseover="this.style.background='rgba(255,255,255,0.06)'"
                 onmouseout="this.style.background='rgba(255,255,255,0.03)'">
                <div style="font-weight:600;color:#e2e8f0;margin-bottom:0.15rem;">${esc(e.title)}</div>
                ${e.category ? `<span style="font-size:0.7rem;padding:0.1rem 0.4rem;border-radius:99px;background:rgba(34,197,94,0.12);color:#00d4dc;">${esc(e.category)}</span>` : ''}
                <div style="font-size:0.75rem;color:#94a3b8;margin-top:0.25rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.content.slice(0, 120))}</div>
                <div style="font-size:0.68rem;color:#475569;margin-top:0.2rem;">${esc(e.source)} · ${new Date(e.createdAt).toLocaleDateString()}</div>
            </div>`).join('');
    } catch (err) {
        s.error('Could not load knowledge base: ' + esc(err.message));
    }
}

function setKbCategory(cat) {
    kbActiveCat = cat || null;
    loadKnowledgeBase();
}

async function viewKbEntry(id, title) {
    document.getElementById('kbDetailTitle').textContent = '🧠 ' + title;
    const detailBody = document.getElementById('kbDetailBody');
    AtomAPI.state(detailBody).loading('Loading…');
    showPanel('kb-detail');
    try {
        const data = await AtomAPI.get(`/knowledge-base/${id}`);
        const e    = data.entry || data;
        detailBody.innerHTML = `
            <div style="margin-bottom:0.75rem;">
                ${e.category ? `<span style="font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:99px;background:rgba(34,197,94,0.12);color:#00d4dc;margin-right:0.4rem;">${esc(e.category)}</span>` : ''}
                <span style="font-size:0.72rem;color:#64748b;">${esc(e.source)} · ${new Date(e.createdAt).toLocaleDateString()}</span>
                ${e.fileName ? `<span style="font-size:0.7rem;color:#64748b;margin-left:0.4rem;">📎 ${esc(e.fileName)}</span>` : ''}
            </div>
            <div style="white-space:pre-wrap;font-size:0.83rem;color:#cbd5e1;line-height:1.6;border-top:1px solid rgba(255,255,255,0.06);padding-top:0.75rem;">${esc(e.content)}</div>
            <div style="margin-top:1rem;display:flex;gap:0.5rem;">
                <button class="panel-action-btn" onclick="deleteKbEntry('${id}')" style="background:rgba(239,68,68,0.12);color:#ef4444;border-color:#ef4444;">🗑 Delete</button>
            </div>`;
    } catch (err) {
        AtomAPI.state(detailBody).error(esc(err.message));
    }
}

async function deleteKbEntry(id) {
    if (!AtomAPI.confirm('Delete this knowledge base entry? This cannot be undone.')) return;
    try {
        await AtomAPI.del(`/knowledge-base/${id}`);
        showPanel('knowledge');
        loadKnowledgeBase();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
}

async function saveKbEntry() {
    const status  = document.getElementById('kbAddStatus');
    const btn     = document.getElementById('kbSaveBtn');
    const title   = document.getElementById('kbEntryTitle').value.trim();
    const content = document.getElementById('kbEntryContent').value.trim();
    const cat     = document.getElementById('kbEntryCategory').value.trim();

    if (!title || !content) {
        status.textContent = 'Title and content are required.'; status.className = 'panel-msg err'; status.style.display = 'block'; return;
    }

    const restore = AtomAPI.withButton(btn, '⏳ Saving…');
    status.textContent = 'Saving…'; status.className = 'panel-msg'; status.style.display = 'block';
    try {
        const data = await AtomAPI.post('/knowledge-base', { title, content, source: 'manual', ...(cat && { category: cat }) });
        if (data.success) {
            status.textContent = `✅ "${title}" saved!`; status.className = 'panel-msg ok';
            document.getElementById('kbEntryTitle').value    = '';
            document.getElementById('kbEntryContent').value  = '';
            document.getElementById('kbEntryCategory').value = '';
        } else {
            status.textContent = `❌ ${data.error || 'Save failed'}`; status.className = 'panel-msg err';
        }
    } catch (err) {
        status.textContent = `❌ ${err.message}`; status.className = 'panel-msg err';
    } finally { restore(); }
}

async function uploadKbFile() {
    const status    = document.getElementById('kbAddStatus');
    const btn       = document.getElementById('kbUploadBtn');
    const fileInput = document.getElementById('kbFileInput');
    const title     = document.getElementById('kbFileTitle').value.trim();
    const cat       = document.getElementById('kbFileCategory').value.trim();

    if (!fileInput.files?.length) {
        status.textContent = 'Please select a file.'; status.className = 'panel-msg err'; status.style.display = 'block'; return;
    }

    const file    = fileInput.files[0];
    const restore = AtomAPI.withButton(btn, '⏳ Uploading…');
    status.textContent = 'Uploading…'; status.className = 'panel-msg'; status.style.display = 'block';
    try {
        const fd = new FormData();
        fd.append('file', file);
        if (title) fd.append('title', title);
        if (cat)   fd.append('category', cat);
        const data = await AtomAPI.postForm('/knowledge-base/upload', fd, { timeoutMs: 60_000 });
        if (data.success) {
            status.textContent = `✅ "${data.entry?.title || file.name}" uploaded!`; status.className = 'panel-msg ok';
            fileInput.value = ''; document.getElementById('kbFileTitle').value = ''; document.getElementById('kbFileCategory').value = '';
        } else {
            status.textContent = `❌ ${data.error || 'Upload failed'}`; status.className = 'panel-msg err';
        }
    } catch (err) {
        status.textContent = `❌ ${err.message}`; status.className = 'panel-msg err';
    } finally { restore(); }
}

// ── Conversations ──────────────────────────────────────────────────────────

async function loadConversations() {
    const body = document.getElementById('conversationsBody');
    const s    = AtomAPI.state(body);
    s.loading('Loading conversations…');
    try {
        const convoFetchId = window.conversationId || 'main';
        const data   = await AtomAPI.get(`/ai/conversations/${encodeURIComponent(convoFetchId)}`);
        const convos = data.conversations || data || [];
        if (!Array.isArray(convos) || convos.length === 0) {
            s.empty('No conversation history yet. Start chatting on the Dashboard!');
            return;
        }
        body.innerHTML = convos.slice(0, 30).map(c => `
            <div class="convo-item" onclick="loadConversationInChat('${esc(c.id || c.conversationId || '')}')">
                <div class="convo-date">${esc(c.createdAt || c.date || c.timestamp || '')}</div>
                <div class="convo-preview">${esc(c.preview || c.lastMessage || c.title || 'Conversation')}</div>
                <div class="convo-count">${c.messageCount || c.messages?.length || ''} messages</div>
            </div>`).join('');
    } catch (err) {
        s.error('Could not load conversations: ' + esc(err.message));
    }
}

function loadConversationInChat(id) {
    if (!id) return;
    window.conversationId = id;
    showPanel('chat');
    updateStatus('Loaded conversation ' + id, 'success');
}

// ── Connections ────────────────────────────────────────────────────────────

async function loadConnections() {
    const body = document.getElementById('connectionsBody');
    const s    = AtomAPI.state(body);
    s.loading('Checking connections…');

    const cards = [];

    // 1. Backend health — note: proxied as /proxy/health not /proxy/api/v1/health
    try {
        const r  = await fetch('/proxy/health');
        cards.push(connCard('⚡', 'Atom Backend', 'Railway server', r.ok ? 'ok' : 'err', r.ok ? 'Online' : 'Offline'));
    } catch { cards.push(connCard('⚡', 'Atom Backend', 'Railway server', 'err', 'Unreachable')); }

    // 2. Gmail — oauth base is /proxy (no /api/v1)
    try {
        const r = await fetch('/proxy/email/oauth/gmail-status');
        const d = await r.json();
        const badge = d.connected ? 'ok' : d.setupRequired ? 'err' : 'warn';
        const label = d.connected ? `Connected (${d.emailAddress || ''})` : d.setupRequired ? 'Setup required' : 'Not connected';
        const extra = d.connected
            ? `<div style="display:flex;gap:0.3rem;"><button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;" onclick="openSettings()">⚙ Settings</button><button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;color:#ef4444;" onclick="disconnectGmail()">Disconnect</button></div>`
            : `<button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;" onclick="openSettings()">Connect</button>`;
        cards.push(connCard('📧', 'Gmail', 'Email & Calendar', badge, label, extra));
    } catch { cards.push(connCard('📧', 'Gmail', 'Email & Calendar', 'warn', 'Status unavailable')); }

    // 3. Outlook
    try {
        const r = await fetch('/proxy/email/oauth/outlook-status');
        const d = await r.json();
        const badge = d.connected ? 'ok' : d.setupRequired ? 'err' : 'warn';
        const label = d.connected ? `Connected (${d.emailAddress || ''})` : d.setupRequired ? 'Setup required' : 'Not connected';
        const extra = d.connected
            ? `<div style="display:flex;gap:0.3rem;"><button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;" onclick="openSettings()">⚙ Settings</button><button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;color:#ef4444;" onclick="disconnectOutlook()">Disconnect</button></div>`
            : `<button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;" onclick="openSettings()">Connect</button>`;
        cards.push(connCard('📨', 'Outlook', 'Microsoft email', badge, label, extra));
    } catch { cards.push(connCard('📨', 'Outlook', 'Microsoft email', 'warn', 'Status unavailable')); }

    // 4. AI + Voice (always active)
    cards.push(connCard('🧠', 'Claude (Anthropic)', 'AI model', 'ok', 'Active'));
    cards.push(connCard('🎙️', 'Whisper (OpenAI)', 'Voice transcription', 'ok', 'Active'));

    // 5. Google Calendar
    try {
        const r = await AtomAPI.get('/integrations/calendar/status');
        const badge = r.connected ? 'ok' : 'warn';
        const label = r.connected ? `Connected (${r.emailAddress || ''})` : r.note || 'Not connected';
        cards.push(connCard('🗓️', 'Google Calendar', 'Calendar sync', badge, label, `<button class="panel-action-btn" style="font-size:0.75rem;padding:0.25rem 0.6rem;" onclick="showPanel('today')">View</button>`));
    } catch { cards.push(connCard('🗓️', 'Google Calendar', 'Calendar sync', 'warn', 'Status unavailable')); }

    // 6. CRM
    try {
        const r = await AtomAPI.get('/integrations/crm/status');
        const badge = r.connected ? 'ok' : 'warn';
        const label = r.connected ? 'Connected' : r.message || 'Not connected';
        cards.push(connCard('🏗️', 'AccuLynx CRM', 'Jobs & contacts', badge, label, `<button class="panel-action-btn" style="font-size:0.75rem;padding:0.25rem 0.6rem;" onclick="showPanel('crm-jobs')">View Jobs</button>`));
    } catch { cards.push(connCard('🏗️', 'AccuLynx CRM', 'Jobs & contacts', 'warn', 'Status unavailable')); }

    body.innerHTML = cards.join('');
}

function connCard(icon, name, sub, badgeCls, badgeLabel, extra = '') {
    return `<div class="conn-card">
        <div class="conn-left">
            <span class="conn-icon">${icon}</span>
            <div><div class="conn-name">${name}</div><div class="conn-sub">${sub}</div></div>
        </div>
        <div style="display:flex;flex-direction:column;align-items:flex-end;gap:0.35rem;">
            <span class="conn-badge ${badgeCls}">${badgeLabel}</span>
            ${extra}
        </div>
    </div>`;
}

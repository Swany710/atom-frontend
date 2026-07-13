/**
 * panels.js — Sidebar navigation, email panels, calendar, CRM, conversations, connections.
 * Depends on: api.js (AtomAPI), chat.js (esc, conversationId, updateSidebarFooter)
 */

// ── Sidebar ────────────────────────────────────────────────────────────────

let currentPanel = 'chat';
let tasksPendingOnly = true;

function responseList(data, keys) {
    if (Array.isArray(data)) return data;
    for (const key of keys || []) {
        if (Array.isArray(data?.[key])) return data[key];
    }
    if (Array.isArray(data?.data)) return data.data;
    if (Array.isArray(data?.items)) return data.items;
    return [];
}

function throwIfBackendError(data) {
    if (data && data.success === false) {
        throw new Error(data.error || data.message || 'Backend request failed');
    }
}

function splitEmailList(value) {
    return String(value || '')
        .split(/[;,]/)
        .map(v => v.trim())
        .filter(Boolean);
}

function splitFullName(value) {
    const parts = String(value || '').trim().split(/\s+/).filter(Boolean);
    const firstName = parts.shift() || '';
    return { firstName, lastName: parts.join(' ') };
}

function formatDateTime(value) {
    if (!value) return '';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return String(value);
    return date.toLocaleString('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
    });
}

function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebarOverlay').classList.add('open');
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebarOverlay').classList.remove('open');
}

function toggleMenu() {
    const sb = document.getElementById('sidebar');
    if (sb && sb.classList.contains('open')) closeSidebar();
    else openSidebar();
}

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
    if (name === 'tasks')         loadScheduledTasks();
    if (name === 'notes')         loadNotes();
}

// ── Inbox ──────────────────────────────────────────────────────────────────

async function loadInbox() {
    const body = document.getElementById('inboxBody');
    const s    = AtomAPI.state(body);
    s.loading('Loading inbox…');
    try {
        const data   = await AtomAPI.get('/integrations/email/read');
        throwIfBackendError(data);
        const emails = responseList(data, ['emails', 'messages']);
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
        throwIfBackendError(data);
        const emails = responseList(data, ['emails', 'messages']);
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
    const recipients = splitEmailList(to);

    if (!recipients.length || !subject || !body) {
        showComposeStatus('Please fill in To, Subject, and Message.', 'err');
        return;
    }
    if (!AtomAPI.confirm(`Send email to ${recipients.join(', ')}?`)) return;

    const restore = AtomAPI.withButton(btn, '⏳ Sending…');
    showComposeStatus('', '');
    try {
        const data = await AtomAPI.post('/integrations/email/send', { to: recipients, subject, body });
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
        throwIfBackendError(data);
        const events = responseList(data, ['events']);
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
        throwIfBackendError(data);
        const events = responseList(data, ['events']);
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
        throwIfBackendError(data);
        const jobs = responseList(data, ['jobs']);
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
        throwIfBackendError(data);
        const contacts = responseList(data, ['contacts']);
        if (!Array.isArray(contacts) || contacts.length === 0) {
            s.empty(search ? `No contacts matching "${esc(search)}"` : 'No contacts found.');
            return;
        }
        body.innerHTML = contacts.map(c => `
            <div class="crm-card">
                <div class="crm-title">${esc(c.name || [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Contact')}</div>
                ${c.email ? `<div class="crm-sub">${esc(c.email)}</div>` : ''}
                ${c.phone ? `<div class="crm-sub">${esc(c.phone)}</div>` : ''}
            </div>`).join('');
    } catch (err) {
        s.error('Could not load contacts: ' + esc(err.message));
    }
}

// ── CRM: Create Lead ───────────────────────────────────────────────────────

async function createCrmLead() {
    const status    = document.getElementById('leadStatus');
    const btn       = document.getElementById('leadSaveBtn');
    const firstName = document.getElementById('leadFirstName')?.value?.trim() || '';
    const lastName  = document.getElementById('leadLastName')?.value?.trim()  || '';
    const name      = [firstName, lastName].filter(Boolean).join(' ');
    const email     = document.getElementById('leadEmail').value.trim();
    const phone     = document.getElementById('leadPhone').value.trim();
    const addr      = document.getElementById('leadAddress').value.trim();
    const city      = document.getElementById('leadCity')?.value?.trim() || '';
    const stateVal  = document.getElementById('leadState')?.value?.trim() || '';
    const zip       = document.getElementById('leadZip')?.value?.trim() || '';
    const notes     = document.getElementById('leadNotes').value.trim();

    if (!firstName) {
        status.textContent   = 'Customer name is required.';
        status.className     = 'panel-msg err';
        status.style.display = 'block';
        return;
    }
    if (!AtomAPI.confirm(`Create lead for "${name}"?`)) return;

    const restore = AtomAPI.withButton(btn, '⏳ Saving…');
    status.style.display = 'none';
    try {
        const data = await AtomAPI.post('/integrations/crm/leads', {
            firstName,
            lastName,
            email,
            phone,
            address: addr,
            city,
            state: stateVal,
            zip,
            source: 'Atom Frontend',
            notes,
        });
        throwIfBackendError(data);
        const lead = data.data || data;
        status.textContent   = `✅ Lead created: ${esc(lead.jobName || lead.name || data.message || name)}`;
        status.className     = 'panel-msg ok';
        status.style.display = 'block';
        ['leadFirstName', 'leadLastName', 'leadEmail', 'leadPhone', 'leadAddress', 'leadCity', 'leadState', 'leadZip', 'leadNotes'].forEach(id => {
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
                return `<button data-action="setKbCategory('${cat === 'All' ? '' : cat}')"
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
            <div data-action="viewKbEntry('${esc(e.id)}')" class="kb-entry-card">
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

async function viewKbEntry(id) {
    document.getElementById('kbDetailTitle').textContent = 'Loading…';
    const detailBody = document.getElementById('kbDetailBody');
    AtomAPI.state(detailBody).loading('Loading…');
    showPanel('kb-detail');
    try {
        const data = await AtomAPI.get(`/knowledge-base/${id}`);
        const e    = data.entry || data;
        document.getElementById('kbDetailTitle').textContent = '🧠 ' + (e.title || 'Entry');
        detailBody.innerHTML = `
            <div style="margin-bottom:0.75rem;">
                ${e.category ? `<span style="font-size:0.72rem;padding:0.15rem 0.5rem;border-radius:99px;background:rgba(34,197,94,0.12);color:#00d4dc;margin-right:0.4rem;">${esc(e.category)}</span>` : ''}
                <span style="font-size:0.72rem;color:#64748b;">${esc(e.source)} · ${new Date(e.createdAt).toLocaleDateString()}</span>
                ${e.fileName ? `<span style="font-size:0.7rem;color:#64748b;margin-left:0.4rem;">📎 ${esc(e.fileName)}</span>` : ''}
            </div>
            <div style="white-space:pre-wrap;font-size:0.83rem;color:#cbd5e1;line-height:1.6;border-top:1px solid rgba(255,255,255,0.06);padding-top:0.75rem;">${esc(e.content)}</div>
            <div style="margin-top:1rem;display:flex;gap:0.5rem;">
                <button class="panel-action-btn" data-action="deleteKbEntry('${id}')" style="background:rgba(239,68,68,0.12);color:#ef4444;border-color:#ef4444;">🗑 Delete</button>
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
        const convoFetchId = window.conversationId || AtomAPI.getUserId();
        if (!convoFetchId) {
            renderLocalConversation(body);
            return;
        }

        const data = await AtomAPI.get(`/ai/conversations/${encodeURIComponent(convoFetchId)}`);
        const messages = responseList(data, ['messages']);

        if (!messages.length) {
            renderLocalConversation(body);
            return;
        }

        body.innerHTML = `
            <div class="panel-msg" style="display:block;margin-bottom:0.65rem;">
                Current session: ${esc(data.conversationId || convoFetchId)} · ${messages.length} messages
            </div>
            ${messages.map(renderHistoryMessage).join('')}`;
    } catch (err) {
        s.error('Could not load conversations: ' + esc(err.message));
    }
}

function renderLocalConversation(body) {
    const messages = window.conversationMessages || [];
    if (!messages.length) {
        AtomAPI.state(body).empty('No conversation history yet. Start chatting on the Dashboard!');
        return;
    }
    body.innerHTML = `
        <div class="panel-msg" style="display:block;margin-bottom:0.65rem;">
            Unsaved browser session · ${messages.length} messages
        </div>
        ${messages.map(renderHistoryMessage).join('')}`;
}

function renderHistoryMessage(message) {
    const role = message.role || 'assistant';
    const content = flattenHistoryContent(message.content);
    const created = message.createdAt || message.timestamp || '';
    return `
        <div class="convo-item">
            <div class="convo-date">${esc(created ? formatDateTime(created) : '')}</div>
            <div class="convo-preview"><strong>${esc(role)}:</strong> ${esc(content || '(empty)')}</div>
        </div>`;
}

function flattenHistoryContent(content) {
    if (typeof content !== 'string') return String(content ?? '');
    try {
        const parsed = JSON.parse(content);
        if (Array.isArray(parsed)) {
            return parsed.map(block => {
                if (block.type === 'text') return block.text || '';
                if (block.type === 'tool_use') return `[tool: ${block.name || 'unknown'}]`;
                if (block.type === 'tool_result') return '[tool result]';
                return block.content || '';
            }).filter(Boolean).join(' ');
        }
    } catch (_) {}
    return content;
}

function loadConversationInChat(id) {
    if (!id) return;
    window.conversationId = id;
    showPanel('chat');
    updateStatus('Loaded conversation ' + id, 'success');
}

// Scheduled Tasks

function setTaskFilter(pendingOnly) {
    tasksPendingOnly = pendingOnly;
    updateTaskFilterButtons();
    loadScheduledTasks();
}

function updateTaskFilterButtons() {
    const pendingBtn = document.getElementById('tasksPendingBtn');
    const allBtn     = document.getElementById('tasksAllBtn');
    if (pendingBtn) {
        pendingBtn.style.background = tasksPendingOnly ? 'rgba(0,212,220,0.18)' : 'transparent';
        pendingBtn.style.color      = tasksPendingOnly ? '#00d4dc' : '#94a3b8';
    }
    if (allBtn) {
        allBtn.style.background = !tasksPendingOnly ? 'rgba(0,212,220,0.18)' : 'transparent';
        allBtn.style.color      = !tasksPendingOnly ? '#00d4dc' : '#94a3b8';
    }
}

async function loadScheduledTasks() {
    const body = document.getElementById('tasksBody');
    const s    = AtomAPI.state(body);
    updateTaskFilterButtons();
    s.loading('Loading tasks...');
    try {
        const path = tasksPendingOnly ? '/proxy/scheduled-tasks/pending' : '/proxy/scheduled-tasks';
        const data = await AtomAPI.get(path);
        const tasks = responseList(data, ['tasks']);

        if (!tasks.length) {
            s.empty(tasksPendingOnly ? 'No pending scheduled tasks.' : 'No scheduled tasks found.');
            return;
        }

        body.innerHTML = tasks.map(renderScheduledTask).join('');
    } catch (err) {
        s.error('Could not load scheduled tasks: ' + esc(err.message));
    }
}

function renderScheduledTask(task) {
    const status = task.status || 'pending';
    const canCancel = status === 'pending';
    return `
        <div class="crm-card">
            <div class="crm-title">${esc(task.description || task.taskType || 'Scheduled task')}</div>
            <div class="crm-sub">${esc(formatDateTime(task.scheduledAt))}</div>
            <div class="crm-sub">${esc(task.taskType || '')}${task.resultSummary ? ' - ' + esc(task.resultSummary) : ''}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.45rem;gap:0.5rem;">
                <span class="crm-badge">${esc(status)}</span>
                ${canCancel ? `<button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;color:#ef4444;border-color:#ef4444;" data-action="cancelScheduledTask('${esc(task.id)}')">Cancel</button>` : ''}
            </div>
        </div>`;
}

async function cancelScheduledTask(id) {
    if (!id || !AtomAPI.confirm('Cancel this scheduled task?')) return;
    try {
        await AtomAPI.del('/proxy/scheduled-tasks/' + encodeURIComponent(id));
        await loadScheduledTasks();
    } catch (err) {
        alert('Could not cancel task: ' + err.message);
    }
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
        const r = await fetch('/proxy/email/oauth/gmail-status', { headers: AtomAPI.authHeaders() });
        const d = await r.json();
        const badge = d.connected ? 'ok' : d.setupRequired ? 'err' : 'warn';
        const label = d.connected ? `Connected (${d.emailAddress || ''})` : d.setupRequired ? 'Setup required' : 'Not connected';
        const extra = d.connected
            ? `<div style="display:flex;gap:0.3rem;"><button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;" data-action="openSettings()">⚙ Settings</button><button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;color:#ef4444;" data-action="disconnectGmail()">Disconnect</button></div>`
            : `<button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;" data-action="openSettings()">Connect</button>`;
        cards.push(connCard('📧', 'Gmail', 'Email & Calendar', badge, label, extra));
    } catch { cards.push(connCard('📧', 'Gmail', 'Email & Calendar', 'warn', 'Status unavailable')); }

    // 3. Outlook
    try {
        const r = await fetch('/proxy/email/oauth/outlook-status', { headers: AtomAPI.authHeaders() });
        const d = await r.json();
        const badge = d.connected ? 'ok' : d.setupRequired ? 'err' : 'warn';
        const label = d.connected ? `Connected (${d.emailAddress || ''})` : d.setupRequired ? 'Setup required' : 'Not connected';
        const extra = d.connected
            ? `<div style="display:flex;gap:0.3rem;"><button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;" data-action="openSettings()">⚙ Settings</button><button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;color:#ef4444;" data-action="disconnectOutlook()">Disconnect</button></div>`
            : `<button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;" data-action="openSettings()">Connect</button>`;
        cards.push(connCard('📨', 'Outlook', 'Microsoft email', badge, label, extra));
    } catch { cards.push(connCard('📨', 'Outlook', 'Microsoft email', 'warn', 'Status unavailable')); }

    // 4. AI + Voice (always active)
    cards.push(connCard('🧠', 'Claude (Anthropic)', 'AI model', 'ok', 'Active'));
    cards.push(connCard('🎙️', 'ElevenLabs', 'Voice — speech-to-text (Scribe) + text-to-speech', 'ok', 'Active'));
    cards.push(connCard('🧮', 'OpenAI', 'Knowledge base search embeddings', 'ok', 'Active'));

    // 5. Google Calendar
    try {
        const r = await AtomAPI.get('/integrations/calendar/status');
        const badge = r.connected ? 'ok' : 'warn';
        const label = r.connected ? `Connected (${r.emailAddress || ''})` : r.note || 'Not connected';
        const calName = r.provider === 'outlook' ? 'Outlook Calendar'
                      : r.provider === 'google'  ? 'Google Calendar'
                      : 'Calendar';
        cards.push(connCard('🗓️', calName, 'Calendar sync', badge, label, `<button class="panel-action-btn" style="font-size:0.75rem;padding:0.25rem 0.6rem;" data-action="showPanel('today')">View</button>`));
    } catch { cards.push(connCard('🗓️', 'Calendar', 'Calendar sync', 'warn', 'Status unavailable')); }

    // 6. CRM
    try {
        const r = await AtomAPI.get('/integrations/crm/status');
        const badge = r.connected ? 'ok' : 'warn';
        const label = r.connected ? 'Connected' : r.message || 'Not connected';
        cards.push(connCard('🏗️', 'AccuLynx CRM', 'Jobs & contacts', badge, label, `<button class="panel-action-btn" style="font-size:0.75rem;padding:0.25rem 0.6rem;" data-action="showPanel('crm-jobs')">View Jobs</button>`));
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

// ── Notes ───────────────────────────────────────────────────────────────────

async function loadNotes() {
    const body = document.getElementById('notesBody');
    if (!body) return;
    const s = AtomAPI.state(body);
    s.loading('Loading notes…');
    try {
        const q    = (document.getElementById('notesSearchInput')?.value || '').trim();
        const path = q ? `/notes?search=${encodeURIComponent(q)}` : '/notes';
        const data = await AtomAPI.get(path);
        const notes = responseList(data, ['notes']);

        if (!notes.length) {
            s.empty(q ? 'No notes match that search.' : 'No notes yet — write one above, or just tell Atom "note that…" in chat.');
            return;
        }
        body.innerHTML = notes.map(renderNote).join('');
    } catch (err) {
        s.error('Could not load notes: ' + esc(err.message));
    }
}

function renderNote(n) {
    const when = n.createdAt ? new Date(n.createdAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
    return `<div class="conn-card" style="align-items:flex-start;">
        <div style="flex:1;min-width:0;">
            ${n.title ? `<div class="conn-name" style="margin-bottom:0.2rem;">${esc(n.title)}</div>` : ''}
            <div style="font-size:0.82rem;color:#cbd5e1;white-space:pre-wrap;word-break:break-word;">${esc(n.content)}</div>
            <div style="font-size:0.7rem;color:#64748b;margin-top:0.35rem;">${esc(when)}</div>
        </div>
        <button class="panel-action-btn" style="font-size:0.72rem;padding:0.2rem 0.5rem;flex-shrink:0;margin-left:0.5rem;"
                data-action="deleteNoteUi('${n.id}')">🗑</button>
    </div>`;
}

async function addNoteFromPanel() {
    const titleEl   = document.getElementById('noteTitleInput');
    const contentEl = document.getElementById('noteContentInput');
    const btn       = document.getElementById('noteSaveBtn');
    const content   = (contentEl?.value || '').trim();
    if (!content) { contentEl?.focus(); return; }

    const done = AtomAPI.withButton(btn, 'Saving…');
    try {
        const res = await AtomAPI.post('/notes', {
            content,
            title: (titleEl?.value || '').trim() || undefined,
        });
        if (res && res.success === false) throw new Error(res.error || 'Save failed');
        if (titleEl)   titleEl.value = '';
        if (contentEl) contentEl.value = '';
        loadNotes();
    } catch (err) {
        alert('Could not save note: ' + err.message);
    } finally {
        done();
    }
}

async function deleteNoteUi(id) {
    if (!confirm('Delete this note?')) return;
    try {
        const res = await AtomAPI.del(`/notes/${id}`);
        if (res && res.success === false) throw new Error(res.error || 'Delete failed');
        loadNotes();
    } catch (err) {
        alert('Could not delete note: ' + err.message);
    }
}

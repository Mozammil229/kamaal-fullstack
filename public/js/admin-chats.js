/* ============================================================================
 * PHASE C — Admin Chats module (blueprint §6).
 * 1-to-1 support threads + broadcast composer, inside the existing admin
 * panel. Rendered into #adminChatsRoot when the "Chats" tab opens.
 *
 * Depends on globals from admin.html: getAuthHeaders(), switchTab().
 * All user-supplied text is HTML-escaped before rendering (XSS hardening).
 * ============================================================================ */
(function () {
    'use strict';

    var currentUserId = null;   // selected thread target (username)
    var currentUsername = null;
    var threadTimer = null;

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function fmtTime(ms) {
        if (!ms) return '';
        try { return new Date(Number(ms)).toLocaleString(); } catch (_) { return ''; }
    }

    function api(path, opts) {
        opts = opts || {};
        var headers = (typeof getAuthHeaders === 'function') ? getAuthHeaders() : {};
        headers['Content-Type'] = 'application/json';
        return fetch(path, {
            method: opts.method || 'GET',
            headers: headers,
            body: opts.body ? JSON.stringify(opts.body) : undefined
        }).then(function (res) {
            if (res.status === 401 && typeof logoutAdmin === 'function') logoutAdmin();
            return res.json().then(function (data) {
                return { status: res.status, data: data };
            });
        });
    }

    /* ---------------- layout ---------------- */

    function renderShell() {
        var root = document.getElementById('adminChatsRoot');
        if (!root || root.dataset.built) return;
        root.dataset.built = '1';
        root.innerHTML =
            '<div class="grid grid-cols-1 lg:grid-cols-3 gap-6">' +
            // user list
            '  <div class="glass-card p-5 rounded-2xl border-t-2 border-t-cyan-500">' +
            '    <h3 class="text-base font-black text-cyan-400 mb-1"><i class="fa-solid fa-users mr-1.5"></i>SUPPORT THREADS</h3>' +
            '    <p class="text-xs text-gray-400 mb-3">Search by username, phone, or Kamal ID.</p>' +
            '    <input id="chatUserSearch" placeholder="Search users…" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs text-white mb-3 focus:outline-none focus:border-cyan-500">' +
            '    <div id="chatUserList" class="space-y-2 max-h-[420px] overflow-y-auto custom-scroll">' +
            '      <div class="text-center text-gray-500 py-6 text-xs">Type to search, or wait…</div>' +
            '    </div>' +
            '  </div>' +
            // thread view
            '  <div class="glass-card p-5 rounded-2xl border-t-2 border-t-indigo-500 lg:col-span-1">' +
            '    <h3 class="text-base font-black text-indigo-400 mb-1"><i class="fa-solid fa-comments mr-1.5"></i>THREAD</h3>' +
            '    <p id="chatThreadMeta" class="text-xs text-gray-400 mb-3">Select a user to open their support thread.</p>' +
            '    <div id="chatThread" class="space-y-2 max-h-[340px] overflow-y-auto custom-scroll bg-gray-950/60 rounded-xl p-3 border border-gray-800 mb-3">' +
            '      <div class="text-center text-gray-500 py-8 text-xs">No thread selected.</div>' +
            '    </div>' +
            '    <form id="chatReplyForm" class="flex space-x-2">' +
            '      <input id="chatReplyText" placeholder="Reply as Kamaal Support…" maxlength="2000" class="flex-1 bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs text-white focus:outline-none focus:border-indigo-500">' +
            '      <button type="submit" class="bg-indigo-600 hover:bg-indigo-500 text-white font-bold px-4 rounded-xl text-xs transition"><i class="fa-solid fa-paper-plane"></i></button>' +
            '    </form>' +
            '  </div>' +
            // broadcast composer
            '  <div class="glass-card p-5 rounded-2xl border-t-2 border-t-amber-500">' +
            '    <h3 class="text-base font-black text-amber-400 mb-1"><i class="fa-solid fa-bullhorn mr-1.5"></i>BROADCAST</h3>' +
            '    <p class="text-xs text-gray-400 mb-3">One message, stored once — users see it in their inbox on next sync. Logged in the audit trail.</p>' +
            '    <form id="chatBroadcastForm" class="space-y-3">' +
            '      <div>' +
            '        <label class="text-[11px] text-gray-400 block mb-1">Audience</label>' +
            '        <select id="bcAudience" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs text-white">' +
            '          <option value="all">Everyone</option>' +
            '          <option value="language">By language</option>' +
            '          <option value="status">By account status</option>' +
            '        </select>' +
            '      </div>' +
            '      <div id="bcLanguageWrap" class="hidden">' +
            '        <label class="text-[11px] text-gray-400 block mb-1">Language</label>' +
            '        <select id="bcLanguage" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs text-white">' +
            '          <option value="en">English</option>' +
            '          <option value="ur">Urdu</option>' +
            '          <option value="pa">Punjabi (Shahmukhi)</option>' +
            '        </select>' +
            '      </div>' +
            '      <div id="bcStatusWrap" class="hidden">' +
            '        <label class="text-[11px] text-gray-400 block mb-1">Status</label>' +
            '        <select id="bcStatus" class="w-full bg-gray-900 border border-gray-700 rounded-xl px-3 py-2 text-xs text-white">' +
            '          <option value="active">Active</option>' +
            '          <option value="banned">Banned</option>' +
            '        </select>' +
            '      </div>' +
            '      <div>' +
            '        <label class="text-[11px] text-gray-400 block mb-1">Message (max 2000 chars)</label>' +
            '        <textarea id="bcBody" rows="4" maxlength="2000" placeholder="Write like a person: greeting, one clear point, what to do, warm close…" class="w-full bg-gray-900 border border-gray-700 rounded-xl p-3 text-xs text-white custom-scroll focus:outline-none focus:border-amber-500"></textarea>' +
            '      </div>' +
            '      <button type="submit" class="w-full bg-amber-600 hover:bg-amber-500 text-white font-bold py-2.5 rounded-xl text-xs transition"><i class="fa-solid fa-paper-plane mr-1.5"></i>SEND BROADCAST</button>' +
            '    </form>' +
            '  </div>' +
            '</div>';

        document.getElementById('chatUserSearch').addEventListener('input', debounce(function (e) {
            loadUsers(e.target.value.trim());
        }, 350));
        document.getElementById('chatReplyForm').addEventListener('submit', onReplySubmit);
        document.getElementById('chatBroadcastForm').addEventListener('submit', onBroadcastSubmit);
        document.getElementById('bcAudience').addEventListener('change', function (e) {
            var v = e.target.value;
            document.getElementById('bcLanguageWrap').classList.toggle('hidden', v !== 'language');
            document.getElementById('bcStatusWrap').classList.toggle('hidden', v !== 'status');
        });
    }

    function debounce(fn, ms) {
        var t = null;
        return function () {
            var args = arguments, self = this;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(self, args); }, ms);
        };
    }

    /* ---------------- user list ---------------- */

    function loadUsers(q) {
        var list = document.getElementById('chatUserList');
        list.innerHTML = '<div class="text-center text-gray-500 py-6 text-xs">Searching…</div>';
        api('/api/admin/messages/users/search?q=' + encodeURIComponent(q || '')).then(function (r) {
            if (!r.data.success) {
                list.innerHTML = '<div class="text-center text-rose-400 py-6 text-xs">' + esc(r.data.error || 'Failed to load users') + '</div>';
                return;
            }
            var users = r.data.users || [];
            if (!users.length) {
                list.innerHTML = '<div class="text-center text-gray-500 py-6 text-xs">No users found.</div>';
                return;
            }
            list.innerHTML = users.map(function (u) {
                var badge = u.adminUnread > 0
                    ? '<span class="ml-1 px-1.5 py-0.5 rounded-full bg-rose-500/20 text-rose-300 text-[10px] font-black">' + u.adminUnread + '</span>'
                    : '';
                return '<button data-uid="' + esc(u.username) + '" class="chat-user-btn w-full text-left px-3 py-2 rounded-xl border border-gray-800 hover:border-cyan-500/50 bg-gray-900/60 transition">' +
                    '<div class="flex items-center justify-between">' +
                    '<span class="text-xs font-bold text-white">@' + esc(u.username) + '</span>' + badge +
                    '</div>' +
                    '<div class="text-[10px] text-gray-400 mt-0.5">' + esc(u.name || '') +
                    (u.kamalId ? ' · <span class="font-mono text-cyan-300">' + esc(u.kamalId) + '</span>' : '') +
                    (u.phone ? ' · ' + esc(u.phone) : '') + '</div>' +
                    '</button>';
            }).join('');
            Array.prototype.forEach.call(list.querySelectorAll('.chat-user-btn'), function (btn) {
                btn.addEventListener('click', function () { openThread(btn.getAttribute('data-uid')); });
            });
        }).catch(function (e) {
            list.innerHTML = '<div class="text-center text-rose-400 py-6 text-xs">Error: ' + esc(e.message) + '</div>';
        });
    }

    /* ---------------- thread ---------------- */

    function openThread(username) {
        currentUsername = username;
        currentUserId = username;
        loadThread();
        if (threadTimer) clearInterval(threadTimer);
        threadTimer = setInterval(loadThread, 15000); // refresh open thread
    }

    function loadThread() {
        if (!currentUserId) return;
        var box = document.getElementById('chatThread');
        var meta = document.getElementById('chatThreadMeta');
        api('/api/admin/messages/' + encodeURIComponent(currentUserId)).then(function (r) {
            if (!r.data.success) {
                box.innerHTML = '<div class="text-center text-rose-400 py-8 text-xs">' + esc(r.data.error || 'Failed to load thread') + '</div>';
                return;
            }
            var u = r.data.user || {};
            meta.innerHTML = '<span class="font-bold text-white">@' + esc(u.username) + '</span>' +
                (u.name ? ' · ' + esc(u.name) : '') +
                (u.kamalId ? ' · <span class="font-mono text-cyan-300">' + esc(u.kamalId) + '</span>' : '') +
                (u.phone ? ' · ' + esc(u.phone) : '') +
                ' <span class="text-gray-500">(' + esc(u.language || 'en') + ' · ' + esc(u.status || 'active') + ')</span>';
            var msgs = r.data.messages || [];
            if (!msgs.length) {
                box.innerHTML = '<div class="text-center text-gray-500 py-8 text-xs">No messages yet. Say salaam first.</div>';
                return;
            }
            box.innerHTML = msgs.map(function (m) {
                var mine = m.sender === 'ADMIN';
                return '<div class="flex ' + (mine ? 'justify-end' : 'justify-start') + '">' +
                    '<div class="max-w-[85%] px-3 py-2 rounded-2xl text-xs ' +
                    (mine ? 'bg-indigo-600/80 text-white rounded-br-md' : 'bg-gray-800 text-gray-100 rounded-bl-md') + '">' +
                    '<div class="whitespace-pre-wrap break-words">' + esc(m.body) + '</div>' +
                    '<div class="text-[9px] mt-1 ' + (mine ? 'text-indigo-200' : 'text-gray-500') + '">' + esc(fmtTime(m.createdAt)) + '</div>' +
                    '</div></div>';
            }).join('');
            box.scrollTop = box.scrollHeight;
        }).catch(function (e) {
            box.innerHTML = '<div class="text-center text-rose-400 py-8 text-xs">Error: ' + esc(e.message) + '</div>';
        });
    }

    function onReplySubmit(e) {
        e.preventDefault();
        if (!currentUserId) { alert('Select a user thread first.'); return; }
        var input = document.getElementById('chatReplyText');
        var body = input.value.trim();
        if (!body) return;
        input.disabled = true;
        api('/api/admin/messages/' + encodeURIComponent(currentUserId), {
            method: 'POST', body: { body: body }
        }).then(function (r) {
            if (r.data.success) {
                input.value = '';
                loadThread();
                loadUsers(document.getElementById('chatUserSearch').value.trim());
            } else {
                alert(r.data.error || 'Failed to send');
            }
        }).catch(function (err) { alert(err.message); })
          .then(function () { input.disabled = false; input.focus(); });
    }

    /* ---------------- broadcast ---------------- */

    function audiencePayload() {
        return {
            audience: document.getElementById('bcAudience').value,
            language: document.getElementById('bcLanguage').value,
            status: document.getElementById('bcStatus').value
        };
    }

    function onBroadcastSubmit(e) {
        e.preventDefault();
        var body = document.getElementById('bcBody').value.trim();
        if (!body) { alert('Write the broadcast message first.'); return; }
        var p = audiencePayload();
        // Step 1: recipient-count preview, then explicit confirm.
        api('/api/admin/broadcast/preview', { method: 'POST', body: p }).then(function (r) {
            if (!r.data.success) { alert(r.data.error || 'Could not count recipients'); return; }
            var label = r.data.audience || p.audience;
            var ok = confirm('Send this broadcast to ' + r.data.count + ' user(s) [' + label + ']?\n\nThis is logged in the admin audit trail.');
            if (!ok) return;
            return api('/api/admin/broadcast', {
                method: 'POST',
                body: { body: body, audience: p.audience, language: p.language, status: p.status }
            }).then(function (r2) {
                if (r2.data.success) {
                    alert('Broadcast sent to ' + r2.data.count + ' user(s). Audit-logged.');
                    document.getElementById('bcBody').value = '';
                } else {
                    alert(r2.data.error || 'Failed to broadcast');
                }
            });
        }).catch(function (err) { alert(err.message); });
    }

    /* ---------------- tab wiring ---------------- */

    function open() {
        renderShell();
        var q = document.getElementById('chatUserSearch');
        loadUsers(q ? q.value.trim() : '');
    }

    // Hook into the panel's tab switcher (defined in admin.html).
    if (typeof window.switchTab === 'function') {
        var origSwitchTab = window.switchTab;
        window.switchTab = function (tabId) {
            origSwitchTab(tabId);
            if (tabId === 'chatsTab') open();
            else if (threadTimer) { clearInterval(threadTimer); threadTimer = null; }
        };
    }
    document.addEventListener('DOMContentLoaded', function () {
        var btn = document.getElementById('btnChatsTab');
        if (btn) btn.addEventListener('click', open);
    });

    window.AdminChats = { open: open, openThread: openThread };
})();

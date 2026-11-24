/* Mauli dashboard – server connection.
   Runs before the dashboard code: checks who is signed in, loads the shared data from the server,
   saves every change back, and replaces the demo sign-in / password screens with server-backed ones. */
(function () {
  "use strict";
  var P = "mauli_", ls = window.localStorage, sp = Storage.prototype;
  var rawSet = sp.setItem, rawRem = sp.removeItem;
  var ME = null, AUTHED = false;

  function xhr(url) {
    var x = new XMLHttpRequest();
    try { x.open("GET", url, false); x.send(); } catch (e) { return { status: 0, text: "" }; }
    return { status: x.status, text: x.responseText };
  }
  function clearLocal() {
    var del = [], i, k;
    for (i = 0; i < ls.length; i++) { k = ls.key(i); if (k && k.indexOf(P) === 0) del.push(k); }
    del.forEach(function (k) { rawRem.call(ls, k); });
  }
  function api(method, url, body) {
    return fetch(url, { method: method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (j) { j.__status = r.status; return j; }); });
  }

  /* ---- 1. who is signed in, and load their data ---- */
  var m = xhr("/api/me");
  if (m.status === 200) {
    try { ME = JSON.parse(m.text); } catch (e) { ME = null; }
    if (ME && !ME.mustChange) {
      var st = xhr("/api/state");
      if (st.status === 200) {
        clearLocal();
        var d = JSON.parse(st.text);
        Object.keys(d).forEach(function (k) { rawSet.call(ls, k, d[k]); });
        AUTHED = true;
      }
    }
  }
  if (!AUTHED) {
    clearLocal();
    var o = xhr("/api/login-options"); /* faculty names only, so the sign-in list can be shown */
    if (o.status === 200) {
      try { rawSet.call(ls, "mauli_staff", JSON.stringify({ fac: JSON.parse(o.text).faculty || [], nts: [] })); } catch (e) {}
    }
  }
  if (AUTHED && ME && ME.form) {
    var css = document.createElement("style");
    css.textContent = "html.mauli-auto #login{display:none!important}";
    document.documentElement.appendChild(css);
    document.documentElement.classList.add("mauli-auto");
  }

  /* ---- 2. save every change to the server (in order) ---- */
  var chain = Promise.resolve();
  function push(method, k, v) {
    chain = chain.then(function () {
      return fetch("/api/kv", { method: method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: k, value: v }), keepalive: !v || v.length < 60000 })
        .then(function (r) {
          if (r.status === 401) { location.reload(); return; }
          if (r.status === 403 || r.status === 400) { if (window.toast) window.toast("Your role is not allowed to save that change"); }
        }).catch(function () { if (window.toast) window.toast("Could not reach the server – change not saved"); });
    });
  }
  sp.setItem = function (k, v) {
    rawSet.call(this, k, v);
    if (AUTHED && this === ls && String(k).indexOf(P) === 0) push("PUT", String(k), String(v));
  };
  sp.removeItem = function (k) {
    rawRem.call(this, k);
    if (AUTHED && this === ls && String(k).indexOf(P) === 0) push("DELETE", String(k), null);
  };

  /* ---- 3. screens ---- */
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (v) { return String(v == null ? "" : v).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var note = function (m) { if (window.toast) window.toast(m); else alert(m); };

  function pwModal(forced, current, done) {
    var box = $("mauliPwModal");
    if (!box) {
      box = document.createElement("div"); box.id = "mauliPwModal"; box.className = "modal";
      box.innerHTML = '<div class="mbox"><h2 id="mpT"></h2><div class="mu" id="mpS"></div>' +
        '<div id="mpCw"><label>Current password</label><input id="mpC" type="password" autocomplete="current-password"></div>' +
        '<label>New password (8+ characters)</label><input id="mpN" type="password" autocomplete="new-password">' +
        '<label>Repeat new password</label><input id="mpR" type="password" autocomplete="new-password">' +
        '<div class="err" id="mpE"></div><div style="display:flex;gap:8px;margin-top:14px"><button class="btn" id="mpOk">Save password</button><button class="btn s" id="mpX" style="margin-left:auto">Cancel</button></div></div>';
      document.body.appendChild(box);
    }
    $("mpT").textContent = forced ? "Choose your own password" : "Change password";
    $("mpS").textContent = forced ? "For security, set a new password before you continue." : "";
    $("mpCw").style.display = current ? "none" : "block";
    $("mpX").style.display = forced ? "none" : "inline-block";
    ["mpC", "mpN", "mpR"].forEach(function (i) { $(i).value = ""; }); $("mpE").textContent = "";
    box.style.display = "flex";
    $("mpX").onclick = function () { box.style.display = "none"; };
    $("mpOk").onclick = function () {
      var n = $("mpN").value, r = $("mpR").value, c = current || $("mpC").value;
      if (n.length < 8) { $("mpE").textContent = "Use at least 8 characters."; return; }
      if (n !== r) { $("mpE").textContent = "The two new passwords do not match."; return; }
      api("POST", "/api/password", { current: c, next: n }).then(function (j) {
        if (j.ok) { box.style.display = "none"; if (done) done(); else note("Password changed"); }
        else $("mpE").textContent = j.error || "Could not change password.";
      });
    };
  }

  function loginWords() {
    var p = document.querySelector("#login p.mu"); if (p) p.textContent = "Sign in with the password issued by your Super Admin. You will be asked to choose your own password the first time.";
    var pw = $("pw"); if (pw) pw.placeholder = "Password";
    var u = $("user"); if (u) { u.placeholder = "Only if you were given a username"; var l = u.previousElementSibling; if (l && l.tagName === "LABEL") l.textContent = "Username (optional)"; }
  }

  function submitLogin() {
    var err = $("err"), body = { role: $("role").value, sub: ($("sub") && $("subw").style.display !== "none") ? $("sub").value : "", user: $("user").value.trim(), password: $("pw").value };
    if (!body.password) { err.textContent = "Enter your password."; return; }
    err.textContent = "";
    api("POST", "/api/login", body).then(function (j) {
      if (!j.ok) { err.textContent = j.error || "Sign-in failed."; return; }
      if (j.mustChange) pwModal(true, body.password, function () { location.reload(); });
      else location.reload();
    }).catch(function () { err.textContent = "Cannot reach the server."; });
  }

  /* ---- Super Admin: server-backed password and account tools ---- */
  var LOGINS = [], ACCTS = [];
  function pwRender() {
    var qv = (($("pwQ") || {}).value || "").toLowerCase();
    return api("GET", "/api/admin/logins").then(function (j) {
      LOGINS = j.logins || [];
      var L = LOGINS.filter(function (x) { return !qv || (x.name + " " + x.group).toLowerCase().indexOf(qv) >= 0; });
      $("pwList").innerHTML = L.length ? L.map(function (x) {
        var i = encodeURIComponent(x.key);
        return '<div class="rc"><div class="rh"><b>' + esc(x.name) + '</b><span class="bd ' + (x.custom ? "ok" : "ns") + '">' + (x.custom ? "Password set" : "Starting password") + '</span></div><div class="mu">' + esc(x.group) + '</div>' +
          '<label>New password</label><input type="password" data-k="' + i + '" placeholder="8+ characters"><div class="ac" style="margin-top:8px"><button class="btn s" onclick="pwSet(\'' + i + '\')">Set password</button>' +
          (x.key === "Super Admin" ? "" : '<button class="btn s" onclick="pwDefault(\'' + i + '\')">Back to starting password</button>') + '</div></div>';
      }).join("") : '<p class="mu">No matching logins.</p>';
    });
  }
  function acRender() {
    return api("GET", "/api/admin/accounts").then(function (j) {
      ACCTS = j.accounts || [];
      var h = $("saAccountList"); if (!h) return;
      h.innerHTML = ACCTS.length ? ACCTS.map(function (x, i) {
        return '<div class="rc"><b>' + esc(x.display) + '</b><div class="mu">' + esc(x.username) + ' · ' + esc(x.role) + (x.dept ? ' · ' + esc(x.dept) : '') + '</div><label>Reset password</label><input id="sapw' + i + '" type="password" placeholder="New password (8+ characters)"><div class="ac" style="margin-top:8px"><button class="btn s" onclick="saResetPassword(' + i + ')">Reset password</button><button class="btn s" onclick="saRemoveAccount(' + i + ')">Remove account</button></div></div>';
      }).join("") : '<p class="mu">No additional accounts created yet.</p>';
    });
  }
  function installAdmin() {
  window.pwRender = pwRender;
  window.pwSet = function (i) {
    var k = decodeURIComponent(i), inp = document.querySelector('#pwList input[data-k="' + i + '"]'), p = inp ? inp.value : "";
    if (p.length < 8) { alert("Enter a new password with at least 8 characters."); return; }
    api("POST", "/api/admin/reset", { key: k, password: p }).then(function (j) {
      if (j.ok) { alert("Password reset for " + k.replace("Faculty:", "") + ". They must choose a new password at their next sign-in."); pwRender(); } else alert(j.error || "Failed");
    });
  };
  window.pwDefault = function (i) {
    var k = decodeURIComponent(i); if (!confirm("Return " + k.replace("Faculty:", "") + " to the starting password?")) return;
    api("POST", "/api/admin/reset-default", { key: k }).then(function (j) { if (j.ok) pwRender(); else alert(j.error || "Failed"); });
  };
  window.pwApplyAll = function () {
    var p = $("pwAll").value; if (p.length < 8) { alert("Enter a temporary password with at least 8 characters."); return; }
    if (!confirm("Set this temporary password for every login except Super Admin? Each person must choose their own at next sign-in.")) return;
    api("POST", "/api/admin/reset-all", { password: p }).then(function (j) { if (j.ok) { $("pwAll").value = ""; pwRender(); alert("Done – " + j.count + " logins reset."); } else alert(j.error || "Failed"); });
  };
  window.pwDefaultAll = function () {
    if (!confirm("Return every login (except Super Admin) to the starting password?")) return;
    api("POST", "/api/admin/reset-default", { all: true }).then(function (j) { if (j.ok) pwRender(); else alert(j.error || "Failed"); });
  };
  window.saCreateAccount = function () {
    var role = $("saRole").value, dept = $("saDept").value;
    var b = { username: $("saUsername").value.trim(), display: $("saDisplay").value.trim(), role: role === "HOD - (select department)" ? "HOD - " + dept : role, dept: dept, password: $("saPassword").value };
    api("POST", "/api/admin/accounts", b).then(function (j) {
      if (j.ok) { $("saUsername").value = ""; $("saDisplay").value = ""; $("saPassword").value = ""; acRender(); alert("Account created. The person must choose a new password at first sign-in."); }
      else alert(j.error || "Failed");
    });
  };
  window.saResetPassword = function (i) {
    var a = ACCTS[i], p = $("sapw" + i).value; if (!a || p.length < 8) { alert("Enter a new password with at least 8 characters."); return; }
    api("POST", "/api/admin/accounts/reset", { username: a.username, password: p }).then(function (j) { if (j.ok) { acRender(); alert("Password reset. They must choose a new one at next sign-in."); } else alert(j.error || "Failed"); });
  };
  window.saRemoveAccount = function (i) {
    var a = ACCTS[i]; if (!a || !confirm("Remove account " + a.username + "?")) return;
    api("POST", "/api/admin/accounts/delete", { username: a.username }).then(function () { acRender(); });
  };

  }

  /* ---- 4. wire everything up once the dashboard code has loaded ---- */
  window.addEventListener("load", function () {
    loginWords();
    installAdmin();
    var proceed = window.doLogin, origLogout = window.logout, origTab = window.saTab;

    window.doLogin = AUTHED ? function () {} : submitLogin;
    window.logout = function () {
      api("POST", "/api/logout", {}).then(function () { clearLocal(); location.reload(); });
    };
    window.saTab = function (t) {
      if (origTab) origTab(t);
      if (t === "pw") pwRender(); if (t === "accounts") acRender();
    };

    var top = document.querySelector(".top .btn.s");
    if (top) { var b = document.createElement("button"); b.className = "btn s"; b.textContent = "Change password"; b.style.marginRight = "8px"; b.onclick = function () { pwModal(false, "", null); }; top.parentNode.insertBefore(b, top); }

    var sa = document.querySelector("#superAdminTools > .mu"); if (sa) sa.textContent = "Manage dashboard data, backups, appearance, accounts, passwords and role appointments. Data is stored on the server and shared by all users.";
    var pn = document.querySelector("#saPw > p.mu"); if (pn) pn.textContent = "Every login (all roles, offices and faculty) can be given its own password. Logins you have not changed use the starting password set at deployment. After a reset, the person must choose a new password at their next sign-in. Passwords need at least 8 characters.";
    var ch = document.querySelector("#saCustom > h2"); if (ch) ch.textContent = "Customize dashboards (applies to all users)";
    var oldSave = window.saSaveCustom;
    if (oldSave) window.saSaveCustom = function () { var a = window.alert; window.alert = function (m) { a(/saved for this browser/.test(m) ? "Customization saved for all users." : m); }; try { oldSave(); } finally { window.alert = a; } };

    if (AUTHED && ME && ME.form) {
      var f = ME.form, role = $("role");
      role.value = f.role; if (role.onchange) role.onchange();
      if (f.sub && $("sub")) $("sub").value = f.sub;
      $("user").value = f.user || "";
      $("pw").value = ME.cur === "Super Admin" ? "superadmin123" : "mauli123"; /* satisfies the page's built-in demo check; real authority is the server session */
      proceed();
      $("pw").value = "";
      if (ME.acct && $("app").style.display === "block") $("who").textContent = "Mauli College of Engineering & Technology, Shegaon · " + ME.disp + " (" + ME.acct + ")";
      var tools = $("superAdminTools"); if (tools) tools.style.display = ME.cur === "Super Admin" ? "block" : "none";
      if (ME.cur === "Super Admin") { acRender(); }
      document.documentElement.classList.remove("mauli-auto");
    } else if (ME && ME.mustChange) {
      pwModal(true, "", function () { location.reload(); }); /* signed in but must set a new password first */
    }
  });
})();

# Mauli College of Engineering & Technology (Shegaon)
## AI-Powered Institutional & NIRF Management Portal

A secure, multi-user web application and database backend for institutional governance, NIRF ranking metrics, KPI monitoring, faculty workload tracking, and administrative control.

---

## 🌐 Live Application Access

The application is currently running live and accessible worldwide on any device (Smartphone, Tablet, Laptop, Desktop):

- **Live Public URL**: **[https://genre-pix-depend-tension.trycloudflare.com](https://genre-pix-depend-tension.trycloudflare.com)**
- **Local / Campus LAN URL**: `http://localhost:3000` (or `http://<CAMPUS-IP>:3000` across college Wi-Fi)

---

## 🔑 Login Credentials

| Role / User | Login Type | Default Password | Permissions / Capabilities |
| :--- | :--- | :--- | :--- |
| **Super Admin** | Role Selector: "Super Admin" | `SuperAdmin@123` *(or `superadmin123`)* | Full administrative control: user accounts, password resets, database backups, system customization, audit logs. |
| **Principal** | Role Selector: "Principal" | `Welcome@123` *(or `mauli123`)* | Campus-wide overview, staff list management, role assignment, executive reporting. |
| **HODs** (CSE, ENTC, MECH, CIVIL, ASH) | Role Selector: "HOD" | `Welcome@123` *(or `mauli123`)* | Department-level KPI tracking, staff oversight, workload and responsibility management. |
| **NIRF Coordinator** | Role Selector: "NIRF Coordinator" | `Welcome@123` *(or `mauli123`)* | Full read/write access to NIRF parameters (TLR, RPC, GO, OI, PR), data imports, ranking forecasts. |
| **IQAC Coordinator** | Role Selector: "IQAC Coordinator" | `Welcome@123` *(or `mauli123`)* | Quality assurance metrics, NAAC/NIRF compliance data, institutional reporting. |
| **Faculty Members** | Name Selector: Pick your name | `Welcome@123` *(or `mauli123`)* | Submit monthly reports, update academic credentials, view department notices. |

> **Note**: For faculty and office accounts, the system automatically enforces a password change upon first login to guarantee individual privacy and credential security.

---

## 🛠️ Architecture & Features

1. **Persistent SQLite Database (`data/mauli.db`)**:
   - Stores user credentials with salted **scrypt** cryptographic hashing.
   - Dynamic Key-Value store with automated version history (`kv_history`, keeping up to 300 historical snapshots for audit recovery).
   - Real-time session management with brute-force lockout (8 failed attempts = 15-minute cooldown).
2. **Universal Dual Backend**:
   - **`server.py` (Python 3)**: Zero external dependencies; runs directly with standard Python 3.8+.
   - **`server.js` (Node.js)**: High-speed native Node.js 22+ implementation using `node:sqlite`.
3. **Seamless Client Bridge (`public/app-sync.js`)**:
   - Bridges the rich single-page application frontend with the backend REST API.
   - Transparently synchronizes data, permissions, and session tokens without interrupting frontend responsiveness.
4. **Instant Cloudflare Tunnel (`cloudflared.exe` / `start_live.py`)**:
   - Exposes local server port to a secure HTTPS Cloudflare edge URL with zero router configuration or port forwarding needed.

---

## 🚀 Running Locally

### Option A: One-Click Live Launch (Local + Public Tunnel)
Double-click `start-live.bat` or run:
```bash
python start_live.py
```
This starts the local web server on port 3000 and automatically creates a secure public HTTPS link for external sharing.

### Option B: Local Only
Double-click `start-server.bat` or run:
```bash
python server.py
# OR
node server.js
```
Then visit `http://localhost:3000` in your web browser.

---

## ☁️ 24/7 Cloud Deployment Guide

To deploy permanently to the cloud for free with 24/7 uptime:

### Deploying to Render.com (Recommended - 100% Free 24/7 Hosting)

Render provides free cloud web hosting with automatic HTTPS and 24/7 global availability.

#### Step 1: Put the Project on GitHub

**Option A (Easiest - via GitHub Web, No Git CLI required):**
1. Go to [github.com](https://github.com) and click **New repository** (name it `mauli-college-dashboard`).
2. On the new repository page, click **uploading an existing file**.
3. Drag and drop all files from this folder (or extract `mauli-college-dashboard-release.zip`) and click **Commit changes**.

**Option B (Using Git):**
```bash
git init
git add .
git commit -m "Deploy Mauli College Dashboard"
git remote add origin https://github.com/<your-username>/mauli-college-dashboard.git
git push -u origin main
```

#### Step 2: Deploy on Render.com
1. Log in to [Render.com](https://render.com) (free signup with GitHub or Google).
2. Click **New +** → **Blueprint** and select your `mauli-college-dashboard` GitHub repository.
3. Render will automatically detect [`render.yaml`](./render.yaml) (using Python runtime: `python server.py` on free tier).
4. Click **Apply**.
5. Render will build and deploy the application in under 2 minutes, giving you a permanent custom link (e.g. `https://mauli-college-dashboard.onrender.com`).
6. All users can now log in 24/7 from anywhere in the world!

### Docker Deployment
Run on any Linux VPS (Ubuntu, Debian, AWS EC2, DigitalOcean):
```bash
docker build -t mauli-dashboard .
docker run -d -p 3000:3000 -v mauli_data:/data -e SUPERADMIN_PASSWORD="YourPassword@123" mauli-dashboard
```

---

## 💾 Backups & Data Security

- **Database file**: All application data, users, and history live in `data/mauli.db`. Copy this single file for complete offline backups.
- **In-App JSON Backup**: Super Admin can click **Backup Database** in the dashboard to download an export of institutional metrics.
- **Audit History**: Every update to staff lists, NIRF metrics, and responsibilities creates an immutable audit row in `kv_history`.

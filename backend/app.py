# backend/app.py
import os
import sys
from datetime import datetime
from flask import Flask, request, jsonify, send_from_directory, abort
from flask_cors import CORS
from werkzeug.security import generate_password_hash, check_password_hash

# Import db and models from models.py (same folder)
from models import db, User, Product, Transaction, TransactionLine

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

# Use OAKS_DB env var if provided (allows switching to Postgres in production)
OAKS_DB = os.environ.get('OAKS_DB')
if OAKS_DB:
    DB_PATH = OAKS_DB
else:
    DB_PATH = f"sqlite:///{os.path.join(BASE_DIR, 'oaks.db')}"

# static folder (where frontend build/files live)
STATIC_FOLDER = os.path.join(BASE_DIR, 'static')

app = Flask(
    __name__,
    static_folder=STATIC_FOLDER,
    static_url_path=''  # serve static files at root
)
app.config['SQLALCHEMY_DATABASE_URI'] = DB_PATH
app.config['SQLALCHEMY_TRACK_MODIFICATIONS'] = False

# Allow cross-origin during development; in production, restrict origins if needed
CORS(app, resources={r"/api/*": {"origins": "*"}})

# initialize db with app
db.init_app(app)

# create tables and default admin (only inside app context)
with app.app_context():
    db.create_all()
    # admin PIN can be set via ADMIN_PIN environment variable for initial bootstrapping
    admin_pin = os.environ.get('ADMIN_PIN', '1234')
    if not User.query.first():
        admin = User(name='admin', pin_hash=generate_password_hash(admin_pin), is_admin=True)
        db.session.add(admin)
        db.session.commit()
        print(f'Created default admin user with name "admin" and PIN "{admin_pin}". Change this immediately!', file=sys.stderr)

# -------------------------
# Helper utilities
# -------------------------
def require_admin(name, pin):
    """Verify that (name,pin) belongs to an admin user. Returns user or None."""
    if not name or not pin:
        return None
    user = User.query.filter_by(name=name).first()
    if not user:
        return None
    if check_password_hash(user.pin_hash, pin) and user.is_admin:
        return user
    return None

# -------------------------
# Serve frontend (SPA)
# -------------------------
@app.route('/', methods=['GET'])
def serve_index():
    # Serve index.html from static folder
    index_path = os.path.join(app.static_folder, 'index.html')
    if os.path.exists(index_path):
        return send_from_directory(app.static_folder, 'index.html')
    return jsonify({'app': 'oaks-mart-backend', 'status': 'no-static-found', 'db': DB_PATH})

# Ensure service worker, manifest, JS, CSS are served normally by static route.
# Browser will request /service-worker.js or /app.js and Flask's static handler will serve them.

# -------------------------
# Health check and info
# -------------------------
@app.route('/api/health', methods=['GET'])
def health():
    return jsonify({'ok': True, 'app': 'oaks-mart-backend', 'db': DB_PATH})

# -------------------------
# Auth endpoints
# -------------------------
@app.route('/api/auth/create_user', methods=['POST'])
def create_user():
    """
    Create a new user on the server.
    JSON: { name, pin, is_admin (optional), admin_name, admin_pin }
    Requires an admin (admin_name/admin_pin) to authorize creation on server.
    """
    data = request.json or {}
    name = (data.get('name') or '').strip()
    pin = (data.get('pin') or '').strip()
    is_admin = bool(data.get('is_admin', False))

    admin_name = data.get('admin_name')
    admin_pin = data.get('admin_pin')
    if not admin_name or not admin_pin:
        return jsonify({'ok': False, 'error': 'admin_name and admin_pin required to create user on server'}), 403

    if not require_admin(admin_name, admin_pin):
        return jsonify({'ok': False, 'error': 'admin auth failed'}), 403

    if not name or not pin:
        return jsonify({'ok': False, 'error': 'name and pin required'}), 400

    if User.query.filter_by(name=name).first():
        return jsonify({'ok': False, 'error': 'user already exists'}), 400

    user = User(name=name, pin_hash=generate_password_hash(pin), is_admin=is_admin)
    db.session.add(user)
    db.session.commit()
    return jsonify({'ok': True, 'user': user.to_dict()})

@app.route('/api/auth/login', methods=['POST'])
def login():
    """
    Login using name and pin.
    JSON: { name, pin }
    Returns user details if ok (no token for now; can be extended)
    """
    data = request.json or {}
    name = (data.get('name') or '').strip()
    pin = (data.get('pin') or '').strip()
    if not name or not pin:
        return jsonify({'ok': False, 'error': 'name and pin required'}), 400

    user = User.query.filter_by(name=name).first()
    if user and check_password_hash(user.pin_hash, pin):
        return jsonify({'ok': True, 'user': user.to_dict()})
    return jsonify({'ok': False, 'error': 'invalid credentials'}), 401

@app.route('/api/auth/change_pin', methods=['POST'])
def change_pin():
    """
    Change a user's PIN on the server.
    JSON: { target_name, new_pin, admin_name, admin_pin }
    Admin credentials required.
    """
    data = request.json or {}
    target_name = (data.get('target_name') or '').strip()
    new_pin = (data.get('new_pin') or '').strip()
    admin_name = data.get('admin_name')
    admin_pin = data.get('admin_pin')

    if not target_name or not new_pin or not admin_name or not admin_pin:
        return jsonify({'ok': False, 'error': 'target_name, new_pin, admin_name, admin_pin required'}), 400

    if not require_admin(admin_name, admin_pin):
        return jsonify({'ok': False, 'error': 'admin auth failed'}), 403

    user = User.query.filter_by(name=target_name).first()
    if not user:
        return jsonify({'ok': False, 'error': 'target user not found'}), 404

    user.pin_hash = generate_password_hash(new_pin)
    db.session.commit()
    return jsonify({'ok': True, 'user': user.to_dict()})

@app.route('/api/users', methods=['GET'])
def list_users():
    """
    List users (admin-only). Query params accepted: admin_name, admin_pin (simple approach).
    """
    admin_name = request.args.get('admin_name')
    admin_pin = request.args.get('admin_pin')
    if not admin_name or not admin_pin or not require_admin(admin_name, admin_pin):
        return jsonify({'ok': False, 'error': 'admin auth required'}), 403
    users = User.query.all()
    return jsonify({'ok': True, 'users': [u.to_dict() for u in users]})

# -------------------------
# Product endpoints
# -------------------------
@app.route('/api/products', methods=['GET'])
def get_products():
    prods = Product.query.order_by(Product.name).all()
    return jsonify([p.to_dict() for p in prods])

@app.route('/api/products', methods=['POST'])
def create_or_update_product():
    """
    Create or update product by barcode.
    JSON: { barcode, name, price, cost, qty, is_new, admin_name, admin_pin }
    """
    data = request.json or {}
    barcode = (data.get('barcode') or '').strip()
    if not barcode:
        return jsonify({'ok': False, 'error': 'barcode required'}), 400

    product = Product.query.filter_by(barcode=barcode).first()
    if not product:
        product = Product(barcode=barcode)
        db.session.add(product)

    if 'name' in data: product.name = data.get('name')
    if 'price' in data: product.price = float(data.get('price') or 0)
    if 'cost' in data: product.cost = float(data.get('cost') or 0)
    if 'qty' in data: product.qty = int(data.get('qty') or 0)
    if 'is_new' in data: product.is_new = bool(data.get('is_new'))

    db.session.commit()
    return jsonify({'ok': True, 'product': product.to_dict()})

# -------------------------
# Sync endpoint
# -------------------------
@app.route('/api/sync', methods=['POST'])
def sync_transactions():
    """
    Accepts: { transactions: [ { local_id, createdAt, total, payment_type, lines: [{barcode,name,qty,price,cost}] }, ... ] }
    Returns: { ok: True, ack: [ { local_id, status, server_id? , error? } ... ], updated_products: [...] }
    """
    payload = request.json or {}
    txs = payload.get('transactions', [])
    ack = []
    updated_products = {}

    for tx in txs:
        local_id = tx.get('local_id')
        try:
            total = float(tx.get('total', 0))
            payment_type = tx.get('payment_type', 'cash')
            created_at = None
            if tx.get('createdAt'):
                try:
                    created_at = datetime.fromisoformat(tx['createdAt'])
                except Exception:
                    created_at = datetime.utcnow()
            t = Transaction(total=total, payment_type=payment_type, synced=True, created_at=created_at or datetime.utcnow())
            db.session.add(t)
            db.session.flush()  # get t.id

            # store lines
            for line in tx.get('lines', []):
                l = TransactionLine(transaction_id=t.id,
                                    barcode=line.get('barcode'),
                                    name=line.get('name'),
                                    qty=int(line.get('qty', 0)),
                                    price=float(line.get('price', 0)),
                                    cost=float(line.get('cost', 0)))
                db.session.add(l)

                # adjust product qty on server if product exists
                prod = Product.query.filter_by(barcode=line.get('barcode')).first()
                if prod:
                    prod.qty = max(0, (prod.qty or 0) - l.qty)
                    updated_products[prod.barcode] = prod.to_dict()

            db.session.commit()
            ack.append({'local_id': local_id, 'status': 'ok', 'server_id': t.id})
        except Exception as e:
            db.session.rollback()
            ack.append({'local_id': local_id, 'status': 'error', 'error': str(e)})

    return jsonify({'ok': True, 'ack': ack, 'updated_products': list(updated_products.values())})

# -------------------------
# AI stub endpoint
# -------------------------
@app.route('/api/ai/suggest', methods=['POST'])
def ai_suggest():
    """
    Basic heuristic-based suggestions for a product.
    Accepts: { barcode: '...', lookback_days: 14 }
    Returns basic metrics and suggestions.
    """
    data = request.json or {}
    barcode = (data.get('barcode') or '').strip()
    lookback_days = int(data.get('lookback_days', 14))

    if not barcode:
        return jsonify({'ok': False, 'error': 'barcode required'}), 400

    prod = Product.query.filter_by(barcode=barcode).first()
    if not prod:
        return jsonify({'ok': False, 'error': 'product not found'}), 404

    # compute sold qty (simple across all history)
    lines = TransactionLine.query.filter_by(barcode=barcode).all()
    total_sold = sum(l.qty for l in lines)
    avg_daily = total_sold / max(1, lookback_days)

    suggested_reorder = 0
    days_of_cover = float('inf') if avg_daily == 0 else prod.qty / avg_daily
    if avg_daily > 0:
        target = max(int(avg_daily * 14), 5)
        suggested_reorder = max(0, target - prod.qty)

    margin = None
    margin_pct = None
    if prod.price is not None and prod.cost is not None:
        margin = prod.price - prod.cost
        margin_pct = (margin / prod.price * 100) if prod.price else 0

    research = [
        {'type': 'placeholder', 'note': 'Competitor pricing research / supplier ETA not implemented in stub.'}
    ]

    resp = {
        'ok': True,
        'product': prod.to_dict(),
        'metrics': {
            'total_sold_in_history': total_sold,
            'avg_daily_estimate': avg_daily,
            'days_of_cover': None if days_of_cover == float('inf') else round(days_of_cover, 1)
        },
        'suggestions': {
            'suggested_reorder_qty': suggested_reorder,
            'safety_target_days': 14,
            'margin_kes': margin,
            'margin_pct': margin_pct
        },
        'research': research
    }
    return jsonify(resp)

# -------------------------
# Fallback for SPA paths (serve index.html)
# -------------------------
@app.errorhandler(404)
def spa_fallback(err):
    """If a static file wasn't found, return index.html so SPA client-router can handle routes."""
    index_path = os.path.join(app.static_folder, 'index.html')
    if os.path.exists(index_path):
        return send_from_directory(app.static_folder, 'index.html')
    return jsonify({'error': 'not found'}), 404

# -------------------------
# Run server
# -------------------------
if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)


# backend/models.py
from datetime import datetime
from flask_sqlalchemy import SQLAlchemy

db = SQLAlchemy()

class User(db.Model):
    __tablename__ = 'user'
    id = db.Column(db.Integer, primary_key=True)
    name = db.Column(db.String(120), unique=True, nullable=False)
    pin_hash = db.Column(db.String(255), nullable=False)
    is_admin = db.Column(db.Boolean, default=False)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'name': self.name,
            'is_admin': self.is_admin,
            'created_at': self.created_at.isoformat()
        }

class Product(db.Model):
    __tablename__ = 'product'
    id = db.Column(db.Integer, primary_key=True)
    barcode = db.Column(db.String(120), unique=True, index=True, nullable=False)
    name = db.Column(db.String(255))
    price = db.Column(db.Float)
    cost = db.Column(db.Float)
    qty = db.Column(db.Integer, default=0)
    is_new = db.Column(db.Boolean, default=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id,
            'barcode': self.barcode,
            'name': self.name,
            'price': self.price,
            'cost': self.cost,
            'qty': self.qty,
            'is_new': self.is_new,
            'created_at': self.created_at.isoformat()
        }

class Transaction(db.Model):
    __tablename__ = 'transaction'
    id = db.Column(db.Integer, primary_key=True)
    created_at = db.Column(db.DateTime, default=datetime.utcnow)
    total = db.Column(db.Float)
    payment_type = db.Column(db.String(50))
    synced = db.Column(db.Boolean, default=False)
    lines = db.relationship('TransactionLine', backref='transaction', lazy=True, cascade='all, delete-orphan')

    def to_dict(self):
        return {
            'id': self.id,
            'created_at': self.created_at.isoformat(),
            'total': self.total,
            'payment_type': self.payment_type,
            'synced': self.synced,
            'lines': [l.to_dict() for l in self.lines]
        }

class TransactionLine(db.Model):
    __tablename__ = 'transaction_line'
    id = db.Column(db.Integer, primary_key=True)
    transaction_id = db.Column(db.Integer, db.ForeignKey('transaction.id'), nullable=False)
    barcode = db.Column(db.String(120))
    name = db.Column(db.String(255))
    qty = db.Column(db.Integer)
    price = db.Column(db.Float)
    cost = db.Column(db.Float)

    def to_dict(self):
        return {
            'id': self.id,
            'transaction_id': self.transaction_id,
            'barcode': self.barcode,
            'name': self.name,
            'qty': self.qty,
            'price': self.price,
            'cost': self.cost
        }

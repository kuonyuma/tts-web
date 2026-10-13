import threading

from argon2 import PasswordHasher
from argon2.exceptions import VerificationError, InvalidHashError


_hasher = PasswordHasher()# 创建 Argon2 密码处理器
_hash_lock = threading.Lock()
_dummy_hash = _hasher.hash("timing padding for an unknown or passwordless account")


def hash_password(password: str) -> str:
    """Hash with Argon2id and a fresh salt, bounding single-worker memory use."""
    with _hash_lock:
        return _hasher.hash(password)


def verify_password(password_hash: str | None, password: str) -> bool:
    """Pad absent/passwordless users and never disclose hash parsing errors."""
    usable = bool(password_hash and password_hash.startswith("$argon2"))
    with _hash_lock:
        try:
            # 如果没有 password_hash，则拿预设的虚拟哈希 _dummy_hash 计算
            _hasher.verify(password_hash if usable else _dummy_hash, password)
        except (VerificationError, InvalidHashError):
            return False
    return usable

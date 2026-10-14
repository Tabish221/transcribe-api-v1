<?php

declare(strict_types=1);

namespace Tapi;

/** User accounts. */
final class Users
{
    public const MIN_PASSWORD = 8;

    public static function find(string $id): ?array
    {
        return self::hydrate(Db::one('SELECT * FROM users WHERE id = ?', [$id]));
    }

    public static function findByEmail(string $email): ?array
    {
        return self::hydrate(Db::one('SELECT * FROM users WHERE email = ?', [self::normalizeEmail($email)]));
    }

    public static function all(): array
    {
        return array_map(static fn (array $row): ?array => self::hydrate($row), Db::all('SELECT * FROM users ORDER BY created_at ASC, email ASC'));
    }

    public static function normalizeEmail(string $email): string
    {
        return strtolower(trim($email));
    }

    /** Validates input and creates a user. Throws 422 on invalid/duplicate data. */
    public static function create(string $name, string $email, string $password, bool $isAdmin = false): array
    {
        $email = self::validateEmail($email);
        if (self::findByEmail($email) !== null) {
            throw ApiException::validation('email', 'A user with this email already exists');
        }
        self::validatePassword($password, 'password');
        $id = Util::id('usr_');
        Db::insert('users', [
            'id' => $id,
            'email' => $email,
            'name' => self::validateName($name, $email),
            'password_hash' => password_hash($password, PASSWORD_DEFAULT),
            'is_admin' => $isAdmin ? 1 : 0,
            'disabled_at' => null,
            'created_at' => time(),
            'last_login_at' => null,
        ]);
        return self::find($id);
    }

    /** Admin update: name?, password?, is_admin?, disabled? (admins cannot demote or disable themselves). */
    public static function update(array $user, array $input, array $actor): array
    {
        $set = [];
        $self = $user['id'] === $actor['id'];
        if (array_key_exists('name', $input)) {
            $set['name'] = self::validateName($input['name'], $user['email']);
        }
        if (array_key_exists('password', $input) && $input['password'] !== null && $input['password'] !== '') {
            $set['password_hash'] = password_hash(self::validatePassword($input['password'], 'password'), PASSWORD_DEFAULT);
        }
        if (array_key_exists('is_admin', $input)) {
            $isAdmin = Validate::bool($input['is_admin']);
            if ($self && !$isAdmin) {
                throw ApiException::validation('is_admin', 'You cannot remove your own administrator role');
            }
            $set['is_admin'] = $isAdmin ? 1 : 0;
        }
        if (array_key_exists('disabled', $input)) {
            $disabled = Validate::bool($input['disabled']);
            if ($self && $disabled) {
                throw ApiException::validation('disabled', 'You cannot disable your own account');
            }
            $set['disabled_at'] = $disabled ? ($user['disabled_at'] ?? time()) : null;
        }
        if ($set !== []) {
            Db::update('users', $set, 'id = ?', [$user['id']]);
        }
        return self::find($user['id']);
    }

    public static function setPassword(string $id, string $password): void
    {
        Db::update('users', ['password_hash' => password_hash($password, PASSWORD_DEFAULT)], 'id = ?', [$id]);
    }

    public static function validateEmail(mixed $email): string
    {
        $email = self::normalizeEmail(is_string($email) ? $email : '');
        if ($email === '' || strlen($email) > 190 || filter_var($email, FILTER_VALIDATE_EMAIL) === false) {
            throw ApiException::validation('email', 'A valid email address is required');
        }
        return $email;
    }

    public static function validatePassword(mixed $password, string $field): string
    {
        if (!is_string($password) || strlen($password) < self::MIN_PASSWORD) {
            throw ApiException::validation($field, 'Password must be at least ' . self::MIN_PASSWORD . ' characters');
        }
        if (strlen($password) > 1024) {
            throw ApiException::validation($field, 'Password is too long');
        }
        return $password;
    }

    public static function validateName(mixed $name, string $fallbackEmail = ''): string
    {
        $name = Util::cleanLine(is_string($name) ? $name : '');
        if ($name === '') {
            $name = $fallbackEmail !== '' ? (string) strstr($fallbackEmail, '@', true) : '';
        }
        if (Util::length($name) > 190) {
            throw ApiException::validation('name', 'Name must be at most 190 characters');
        }
        return $name;
    }

    /** Public user shape: {"id","email","name","is_admin","created_at"} (+ admin-only fields). */
    public static function serialize(array $user, bool $adminView = false): array
    {
        $out = [
            'id' => $user['id'],
            'email' => $user['email'],
            'name' => $user['name'],
            'is_admin' => (bool) $user['is_admin'],
            'created_at' => Util::iso($user['created_at']),
        ];
        if ($adminView) {
            $out['disabled'] = $user['disabled_at'] !== null;
            $out['last_login_at'] = Util::iso($user['last_login_at']);
        }
        return $out;
    }

    private static function hydrate(?array $row): ?array
    {
        if ($row === null) {
            return null;
        }
        $row['is_admin'] = (int) $row['is_admin'];
        $row['created_at'] = (int) $row['created_at'];
        $row['disabled_at'] = Util::intOrNull($row['disabled_at']);
        $row['last_login_at'] = Util::intOrNull($row['last_login_at']);
        return $row;
    }
}

<?php

declare(strict_types=1);

namespace Tapi\Api;

use Tapi\ApiException;
use Tapi\ApiKeys;
use Tapi\AudioStream;
use Tapi\Auth;
use Tapi\Config;
use Tapi\Projects;
use Tapi\Request;
use Tapi\Response;
use Tapi\Router;
use Tapi\Transcriptions;
use Tapi\Users;
use Tapi\Validate;

/**
 * Dashboard API (/api/dash): session cookie + X-CSRF-Token on every non-GET request
 * (except login/register), JSON bodies, same-origin only.
 */
final class DashApi
{
    public static function register(Router $r): void
    {
        $p = '/api/dash';
        $r->post("$p/login", [self::class, 'login']);
        $r->post("$p/logout", [self::class, 'logout']);
        $r->post("$p/register", [self::class, 'signUp']);
        $r->get("$p/me", [self::class, 'me']);
        $r->post("$p/password", [self::class, 'password']);

        $r->get("$p/projects", [self::class, 'listProjects']);
        $r->post("$p/projects", [self::class, 'createProject']);
        $r->get("$p/projects/{id}", [self::class, 'showProject']);
        $r->patch("$p/projects/{id}", [self::class, 'updateProject']);
        $r->delete("$p/projects/{id}", [self::class, 'deleteProject']);
        $r->post("$p/projects/{id}/webhook-secret", [self::class, 'rotateWebhookSecret']);

        $r->get("$p/projects/{id}/keys", [self::class, 'listKeys']);
        $r->post("$p/projects/{id}/keys", [self::class, 'createKey']);
        $r->delete("$p/projects/{id}/keys/{keyId}", [self::class, 'revokeKey']);

        $r->get("$p/projects/{id}/members", [self::class, 'listMembers']);
        $r->post("$p/projects/{id}/members", [self::class, 'addMember']);
        $r->delete("$p/projects/{id}/members/{userId}", [self::class, 'removeMember']);

        $r->get("$p/projects/{id}/transcriptions", [self::class, 'listTranscriptions']);
        $r->post("$p/projects/{id}/transcriptions", [self::class, 'createTranscription']);
        $r->get("$p/transcriptions/{id}", [self::class, 'showTranscription']);
        $r->delete("$p/transcriptions/{id}", [self::class, 'deleteTranscription']);
        $r->get("$p/transcriptions/{id}/audio", [self::class, 'transcriptionAudio']);

        $r->get("$p/users", [self::class, 'listUsers']);
        $r->post("$p/users", [self::class, 'createUser']);
        $r->patch("$p/users/{id}", [self::class, 'updateUser']);
    }

    // ----- session -----

    public static function login(Request $request): void
    {
        Auth::checkSignInRequest($request);
        Auth::startSession($request);
        $email = $request->input('email');
        $password = $request->input('password');
        if (!is_string($email) || trim($email) === '') {
            throw ApiException::validation('email', 'Email is required');
        }
        if (!is_string($password) || $password === '') {
            throw ApiException::validation('password', 'Password is required');
        }
        $user = Auth::login($email, $password);
        Response::json(['user' => Users::serialize($user), 'csrf_token' => Auth::csrfToken()]);
    }

    public static function logout(Request $request): void
    {
        Auth::resumeSession($request);
        if (Auth::user() !== null) {
            Auth::checkCsrf($request);
        }
        Auth::logout();
        Response::json(['ok' => true]);
    }

    public static function signUp(Request $request): void
    {
        if (!Config::get('allow_registration')) {
            throw ApiException::forbidden('Registration is disabled on this server');
        }
        Auth::checkSignInRequest($request);
        Auth::startSession($request);
        $user = Users::create(
            self::string($request, 'name'),
            self::string($request, 'email'),
            self::string($request, 'password'),
            false
        );
        Auth::signIn($user);
        Response::json(['user' => Users::serialize($user), 'csrf_token' => Auth::csrfToken()], 201);
    }

    public static function me(Request $request): void
    {
        Auth::resumeSession($request);
        $user = Auth::user();
        $config = [
            'allow_registration' => (bool) Config::get('allow_registration'),
            'engines' => ['cloud' => Config::cloudEnabled(), 'worker' => Config::workerEnabled()],
            'allowed_extensions' => Config::allowedExtensions(),
            'max_upload_mb' => (int) Config::get('max_upload_mb', 100),
            'cloud_max_mb' => (int) Config::get('cloud.max_mb', 25),
            'base_url' => $request->baseUrl(),
            'version' => TAPI_VERSION,
        ];
        if ($user === null) {
            Auth::closeSession();
            // 401 still carries the public config so the login screen knows whether to offer registration.
            Response::json(['error' => ['code' => 'unauthorized', 'message' => 'Please sign in'], 'config' => $config], 401);
            return;
        }
        $csrf = Auth::csrfToken();
        Auth::closeSession();
        Response::json(['user' => Users::serialize($user), 'csrf_token' => $csrf, 'config' => $config]);
    }

    public static function password(Request $request): void
    {
        $user = self::guard($request, true);
        $current = $request->input('current_password');
        if (!is_string($current) || !password_verify($current, (string) $user['password_hash'])) {
            throw ApiException::validation('current_password', 'Current password is incorrect');
        }
        $new = Users::validatePassword($request->input('new_password'), 'new_password');
        Users::setPassword($user['id'], $new);
        Auth::refresh(Users::find($user['id']));
        Response::json(['ok' => true]);
    }

    // ----- projects -----

    public static function listProjects(Request $request): void
    {
        $user = self::guard($request);
        Response::json(['data' => Projects::listFor($user)]);
    }

    public static function createProject(Request $request): void
    {
        $user = self::guard($request);
        $project = Projects::create($user, $request->input('name'));
        Response::json(Projects::serialize($project, 'owner', null, true), 201);
    }

    public static function showProject(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project, $role] = Projects::access($user, $id);
        $stats = Projects::stats([$project['id']])[$project['id']] ?? null;
        Response::json(Projects::serialize($project, $role, $stats, true));
    }

    public static function updateProject(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project, $role] = Projects::access($user, $id, true);
        $project = Projects::update($project, $request->json());
        $stats = Projects::stats([$project['id']])[$project['id']] ?? null;
        Response::json(Projects::serialize($project, $role, $stats, true));
    }

    public static function deleteProject(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id, true);
        Projects::delete($project);
        Response::json(['id' => $project['id'], 'deleted' => true]);
    }

    public static function rotateWebhookSecret(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id, true);
        Response::json(['webhook_secret' => Projects::rotateSecret($project)]);
    }

    // ----- API keys (owners only) -----

    public static function listKeys(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id, true);
        Response::json(['data' => ApiKeys::list($project['id'])]);
    }

    public static function createKey(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id, true);
        Response::json(ApiKeys::create($project['id'], $request->input('name'), $user['id']), 201);
    }

    public static function revokeKey(Request $request, string $id, string $keyId): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id, true);
        Response::json(ApiKeys::revoke($project['id'], $keyId));
    }

    // ----- members -----

    public static function listMembers(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id);
        Response::json(['data' => Projects::members($project['id'])]);
    }

    public static function addMember(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id, true);
        Response::json(Projects::addMember($project, $request->input('email'), $request->input('role', 'member')), 201);
    }

    public static function removeMember(Request $request, string $id, string $userId): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id, true);
        Projects::removeMember($project, $userId);
        Response::json(['user_id' => $userId, 'deleted' => true]);
    }

    // ----- transcriptions -----

    public static function listTranscriptions(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id);
        Response::json(Transcriptions::list($project['id'], $request));
    }

    public static function createTranscription(Request $request, string $id): void
    {
        $user = self::guard($request);
        [$project] = Projects::access($user, $id);
        [$status, $body] = Transcriptions::createFromUpload($project, null, $user['id']);
        Response::json($body, $status);
    }

    public static function showTranscription(Request $request, string $id): void
    {
        $row = self::transcriptionFor(self::guard($request), $id);
        PublicApi::sendTranscription($row, $request->query('format'));
    }

    public static function deleteTranscription(Request $request, string $id): void
    {
        $row = self::transcriptionFor(self::guard($request), $id);
        Transcriptions::delete($row);
        Response::json(['id' => $row['id'], 'deleted' => true]);
    }

    public static function transcriptionAudio(Request $request, string $id): void
    {
        $row = self::transcriptionFor(self::guard($request), $id);
        $path = Transcriptions::audioPath($row);
        if ($path === null) {
            throw ApiException::notFound('The audio file has been deleted');
        }
        AudioStream::send($path, Transcriptions::audioMime($row), (string) $row['filename']);
    }

    // ----- users (admins only) -----

    public static function listUsers(Request $request): void
    {
        self::guard($request);
        Auth::requireAdmin();
        Response::json(['data' => array_map(static fn (array $u): array => Users::serialize($u, true), Users::all())]);
    }

    public static function createUser(Request $request): void
    {
        self::guard($request);
        Auth::requireAdmin();
        $user = Users::create(
            self::string($request, 'name'),
            self::string($request, 'email'),
            self::string($request, 'password'),
            Validate::bool($request->input('is_admin', false))
        );
        Response::json(Users::serialize($user, true), 201);
    }

    public static function updateUser(Request $request, string $id): void
    {
        self::guard($request, true);
        $actor = Auth::requireAdmin();
        $user = Users::find($id);
        if ($user === null) {
            throw ApiException::notFound('User not found');
        }
        $updated = Users::update($user, $request->json(), $actor);
        if ($updated['id'] === $actor['id']) {
            Auth::refresh($updated); // keep this session valid if the admin changed their own password
        }
        Auth::closeSession();
        Response::json(Users::serialize($updated, true));
    }

    // ----- helpers -----

    /**
     * Starts the session, enforces CSRF on non-GET requests and returns the signed-in user.
     * The session lock is released immediately unless $writeSession (long uploads must not block other tabs).
     */
    private static function guard(Request $request, bool $writeSession = false): array
    {
        Auth::resumeSession($request);
        $user = Auth::requireUser();
        if (!in_array($request->method, ['GET', 'HEAD'], true)) {
            Auth::checkCsrf($request);
        }
        if (!$writeSession) {
            Auth::closeSession();
        }
        return $user;
    }

    private static function transcriptionFor(array $user, string $id): array
    {
        $row = Transcriptions::find($id);
        if ($row === null) {
            throw ApiException::notFound('Transcription not found');
        }
        try {
            Projects::access($user, (string) $row['project_id']);
        } catch (ApiException $e) {
            throw ApiException::notFound('Transcription not found');
        }
        return $row;
    }

    /** A string body field ('' when missing or not a string). */
    private static function string(Request $request, string $key): string
    {
        $value = $request->input($key);
        return is_string($value) ? $value : '';
    }
}

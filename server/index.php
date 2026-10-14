<?php
/**
 * Transcribe API - front controller.
 *
 * Apache/LiteSpeed: .htaccess rewrites every request that is not a real file to this script.
 * Local testing:    php -S 127.0.0.1:8091 server/index.php   (this file is also the router script)
 *
 * Without mod_rewrite, use index.php/api/v1/... or index.php?route=/api/v1/...
 */

declare(strict_types=1);

require_once __DIR__ . '/src/bootstrap.php';

\Tapi\App::run();

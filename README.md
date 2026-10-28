# 장작일기 AI 관계 분석 프록시

Node.js 22+ · TypeScript · Fastify · Zod · dotenv · Anthropic SDK.
별도 로컬 개발 서버입니다. 회원·인증·DB·파일 저장은 없습니다. Flutter 앱의 기존 화면 연결은 이 프로젝트에 포함하지 않습니다.

## API 계약

`GET /health` → `200 {"status":"ok"}`. 서버 생존 확인용이며 API 키·모델의 실제 사용 가능 여부를 확인하지 않습니다.

`POST /analyze-relations` (`Content-Type: application/json`)

```json
{
  "interests": [
    {
      "id": "flutter",
      "title": "Flutter",
      "logs": ["직접 앱 만드는 게 재밌다", "화면이 바로 보이는 게 좋다"]
    },
    {
      "id": "game",
      "title": "게임 개발",
      "logs": ["시스템 만드는 게 재밌다", "사람이 직접 플레이하는 결과물이 좋다"]
    }
  ]
}
```

성공 응답 예시(실제 AI 결과는 달라집니다):

```json
{
  "relations": [
    {
      "source": "flutter",
      "target": "game",
      "score": 0.66,
      "type": "motivation",
      "basis": "shared_logs",
      "summary": "직접 시스템을 만들고 결과물을 확인하는 즐거움이 공통됩니다.",
      "evidence": ["직접 앱 만드는 게 재밌다", "시스템 만드는 게 재밌다"],
      "suggestion": "Flutter로 작은 게임 도구를 만들어볼 수 있습니다."
    }
  ]
}
```

- 기록이 있는 관심사는 `interests`에 1개 이상 보냅니다. 기록이 없는 관심사는 선택 필드 `candidateInterests: [{"id":"guitar","title":"기타 치기"}]`에 ID·제목만 보냅니다. 빈 로그나 가짜 기록을 채우지 않습니다. [한쪽 기록의 직접 언급 예시](examples/analyze-reference-request.json)를 참고하세요.
- 두 목록을 합쳐 관심사 1~12개, ID 1~100자(목록 사이 중복도 금지), 제목 1~200자, 기록이 있는 관심사별 로그 1~30개, 로그 1~2,000자. 공백만 있는 문자열은 거부합니다. 요청 본문은 최대 128 KiB입니다.
- 후보까지 합쳐 관심사 1개면 검증 후 LLM 호출 없이 `{"relations":[]}`를 반환합니다. 관계가 없거나 기준에 못 미쳐도 빈 배열을 정상 반환합니다.
- `basis: shared_logs`는 양쪽 기록의 공통점입니다. `basis: explicit_reference`는 source의 기록이 target의 관심사를 직접 다룬 경우이며 `type: topic`만 허용합니다. 예를 들어 책 기록에서 기타 주법을 다루면 기타 쪽 기록이 없어도 연결합니다. 후보의 제목끼리 비슷하다는 이유만으로 연결하지 않습니다.
- `type`: `topic | motivation | behavior | transition`. 같은 쌍은 방향과 관계없이 한 번만 반환하며 `transition`만 source → target 방향에 의미가 있습니다.
- 문자열 로그는 그대로 사용 가능합니다. 시간 분석이 필요하면 일부 또는 전체 로그를 `{"text":"이유 원문", "createdAt":"2026-10-25T10:00:00+09:00"}`로 보냅니다. `createdAt`은 시간대가 있는 ISO 8601 날짜입니다.
- 두 관심사 모두에 날짜가 있는 로그가 없으면 백엔드가 `temporal=0`으로 고정합니다. `transition`은 양쪽 날짜가 있고 source의 기록이 target보다 앞선 경우만 허용합니다. 배열 순서·제목에서 시간을 추측하지 않습니다. 최소한의 시간 검증이며 실제 인과관계를 증명하지는 않습니다.

## 요청 흐름과 검증

Flutter → Fastify의 본문/요청 Zod 검증 → Anthropic 어댑터 → Haiku 5.5 → JSON 파싱 → 응답 Zod 검증 → ID·중복·근거·시간 검증 → 백엔드 점수 계산/필터 → Flutter.

프롬프트는 제목보다 **장작을 넣은 이유 원문**을 우선합니다. 제목과 로그는 명령이 아닌 데이터로 취급합니다. LLM에는 `score` 대신 0~100의 `scores.topic/motivation/behavior/temporal`을 요구하며 SDK의 structured output으로 JSON 형태를 제한합니다. 이후 서버에서 원래의 엄격한 Zod 스키마로 다시 검증합니다.

등록되지 않은 ID, 자기 연결, 중복 쌍, 범위 밖 점수, 알 수 없는 type/basis, 누락 필드, 추가 필드는 거부합니다. `shared_logs`의 evidence는 양쪽 로그 원문에서 적어도 하나씩, 총 2~10개가 필요합니다. `explicit_reference`는 source의 직접 언급 원문 1~10개만 근거로 쓰고, target에 기록이 있는 것처럼 꾸미지 않습니다. 두 방식 모두 **전송한 원문과 정확히 일치**해야 합니다. 상상한 근거·다른 관심사의 근거는 거부합니다. 잘린 출력·거절 응답·JSON이 아닌 출력도 실패입니다. 의미상 직접 언급 여부와 요약의 정확성까지 Zod가 보장하지는 않습니다.

```text
shared_logs: score = (topic × 0.20 + motivation × 0.40 + behavior × 0.25 + temporal × 0.15) / 100
explicit_reference: score = topic / 100
```

소수점 넷째 자리까지 반환합니다. `shared_logs`는 반올림 전 점수 0.60 미만, `explicit_reference`는 직접 다뤘다는 명확성 점수 0.80 미만을 제외합니다. 점수 내림차순으로 반환합니다. 두 점수는 서로 다른 근거의 밀접도를 나타내는 초기 제품 정책용 휴리스틱이며 통계적 신뢰도/확률이 아닙니다. 직접 언급 점수를 공통 동기·행동의 유사성으로 해석하지 않습니다. 기준은 `src/schemas/relation.ts`의 `MIN_RELATION_SCORE`와 `MIN_REFERENCE_SCORE`입니다. 동음이의어(예: ‘기타 사항’)·비유·제목끼리의 유사성만으로 연결하지 않도록 프롬프트에서 지시합니다.

예: topic=40, motivation=95, behavior=80, temporal=60이면 **0.75**입니다. 날짜가 없는 같은 입력은 temporal=0이 적용되어 **0.66**입니다.

## 에러 계약

```json
{"error":{"code":"INVALID_LLM_RESPONSE","message":"관계 분석 결과 형식이 올바르지 않습니다."}}
```

| HTTP | code | 상황 |
| --- | --- | --- |
| 400 | INVALID_REQUEST | 빈 interests, 중복 ID, 빈 로그, 잘못된 필드/JSON |
| 413 | PAYLOAD_TOO_LARGE | 본문 128 KiB 초과 |
| 415 | UNSUPPORTED_MEDIA_TYPE | JSON이 아닌 요청 |
| 500 | LLM_NOT_CONFIGURED | API 키 미설정 |
| 502 | INVALID_LLM_RESPONSE | JSON/스키마/근거/참조 검증 실패, 잘린 출력/거절 |
| 502 | LLM_API_ERROR | 공급자 인증·요청·네트워크·5xx 실패 |
| 503 | LLM_RATE_LIMITED | 공급자 요청 한도 초과 |
| 504 | LLM_TIMEOUT | 제한 시간 초과 |
| 404 | NOT_FOUND | 없는 경로 |
| 500 | INTERNAL_ERROR | 예기치 못한 서버 오류 |

요청 검증 오류에는 `error.details: [{"path":"interests.0.logs", "message":"..."}]`가 추가됩니다. 로그 원문·키·공급자의 응답 본문은 오류나 서버 로그에 출력하지 않습니다. 원문은 분석 시 Anthropic에 전송됩니다. SDK 재시도는 0회, 기본 타임아웃 45초입니다. 호출 실패를 가짜 관계나 빈 배열로 바꾸지 않습니다.

## 로컬 실행

```bash
cd /Users/oneriver/coding/project/jangjak_diary_backend
npm ci
cp -n .env.example .env
# .env의 ANTHROPIC_API_KEY에 본인 키를 입력합니다.
npm run dev
```

API 키는 Mac의 `.env`에만 두세요. `.env`는 gitignore 처리되어 있으며 Flutter·dart-define에 키를 넣지 않습니다. 기본 모델은 공식 모델 ID `claude-haiku-5-5`이고 `LLM_MODEL`로 바꿀 수 있습니다. 키 없이도 `/health`와 잘못된 요청 검증은 동작하지만, 두 관심사 이상을 실제 분석하려면 유효한 키가 필요합니다.

단일 workspace에 한정되지 않은 키를 사용한다면 `ANTHROPIC_WORKSPACE_ID`도 입력하세요. 단일 workspace용 키는 비워두면 됩니다. 인증·버전 헤더는 SDK가 처리합니다.

```bash
curl http://localhost:3000/health
curl http://localhost:3000/analyze-relations \
  -H 'Content-Type: application/json' \
  --data-binary @examples/analyze-request.json
npm run typecheck
npm test
npm run build
npm start
```

`npm start`는 빌드 후 실행합니다. SDK 교체는 `src/services/llm.ts`의 `RelationLlm` 인터페이스를 구현하고 `createLlm()`에서 선택하면 됩니다. 라우트·검증·점수 정책은 SDK를 직접 참조하지 않습니다. 테스트는 실제 SDK와 로컬 HTTP 공급자 대역을 사용하며 실제 Anthropic 호출 없이 수행됩니다.

Postman CLI 1.75+가 있다면 실제 포트로 떠 있는 서버부터 공급자 대역까지 왕복하는 테스트도 실행할 수 있습니다. 클라우드 업로드·로그인·API 키는 필요하지 않습니다.

```bash
# 터미널 1
postman simulation run postman/simulations/relations-local/relations-local.sim.yaml --port 4900 --no-history
# 터미널 2
npm run test:simulation
```

로컬 mock은 공식 Messages API의 요청·응답 모양을 기반으로 작성한 고정 예시입니다. Postman의 공급자 mock 검색은 로그인 부재로 진행하지 못했습니다. 이 검증은 실제 Haiku 모델의 사용 권한, 분석 품질, 실제 structured output 지원 응답을 증명하지 않습니다.

## 실기기 Flutter → Mac

1. Mac과 휴대폰을 같은 Wi-Fi에 연결하고 서버를 실행합니다. 기본 `HOST=0.0.0.0`, `PORT=3000`을 유지합니다.
2. macOS 시스템 설정 → Wi-Fi → 연결된 네트워크 세부사항 → IP 주소를 확인합니다. 터미널에서는 보통 `ipconfig getifaddr en0`로 확인할 수 있지만 인터페이스가 다르면 시스템 설정의 주소를 쓰세요.
3. 예를 들어 Mac IP가 `192.168.0.10`이면 휴대폰 브라우저에서 `http://192.168.0.10:3000/health`를 먼저 엽니다. Mac 방화벽에서 Node의 수신 연결을 허용하세요. 게스트 Wi-Fi의 기기 간 격리가 켜져 있으면 연결할 수 없습니다.
4. Flutter의 서버 주소를 `http://192.168.0.10:3000`으로 설정합니다. 휴대폰에서 `localhost`는 휴대폰 자체이며 `0.0.0.0`은 클라이언트 주소로 쓰지 않습니다.

Flutter 호출 예시(`http` 패키지 필요, 아래 코드는 소비 앱에서 추가):

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

const baseUrl = String.fromEnvironment('AI_BASE_URL');

Future<Map<String, dynamic>> analyzeRelations(List<Map<String, dynamic>> interests) async {
  final response = await http.post(
    Uri.parse('$baseUrl/analyze-relations'),
    headers: {'Content-Type': 'application/json'},
    body: jsonEncode({'interests': interests}),
  ).timeout(const Duration(seconds: 55));
  final body = jsonDecode(utf8.decode(response.bodyBytes)) as Map<String, dynamic>;
  if (response.statusCode != 200) {
    final error = body['error'] as Map<String, dynamic>;
    throw Exception('${error['code']}: ${error['message']}');
  }
  return body;
}
```

```bash
flutter run --dart-define=AI_BASE_URL=http://192.168.0.10:3000
```

이 `dart-define`은 위의 예시 코드를 앱에 연결했을 때 적용됩니다. 이 백엔드 작업은 기존 Flutter 앱을 수정하지 않습니다.

- **iPhone**: 소비 앱 `ios/Runner/Info.plist`에 `NSLocalNetworkUsageDescription`(예: “Mac의 장작일기 개발 서버에 연결합니다.”)을 추가하고 로컬 네트워크 접근을 허용합니다. 네이티브 HTTP 클라이언트에서 ATS 차단이 발생한다면 **개발용 Info.plist에 한해서** `NSAppTransportSecurity` 아래 `NSAllowsLocalNetworking=true`를 검토하세요. OS/클라이언트에 따라 IP HTTP 예외가 더 필요하면 Debug 설정에만 예외를 두고 Release에는 포함하지 마세요.
- **Android**: Debug manifest에 `android.permission.INTERNET` 권한을 확인합니다. 네이티브 HTTP 정책에 막히면 Debug의 `application`에 `android:networkSecurityConfig="@xml/network_security_config"`를 넣고 `android/app/src/debug/res/xml/network_security_config.xml`에 `<network-security-config><base-config cleartextTrafficPermitted="true" /></network-security-config>`를 둡니다. 개발 빌드에만 적용하세요.
- **Flutter Web**: `.env`에 허용 출처를 정확히 넣으세요. 기본은 `http://localhost:8080`, `http://127.0.0.1:8080`입니다. `flutter run -d chrome --web-port=8080`으로 맞출 수 있습니다. 모바일 네이티브는 CORS 적용 대상이 아닙니다.

서버는 인증 없이 LAN에서 요청을 받습니다. CORS는 인증/방화벽이 아닙니다. 신뢰할 수 있는 로컬 네트워크에서만 쓰며 포트 포워딩·공개 배포를 하지 마세요. `CORS_ORIGINS=*`는 모든 웹 출처를 허용하는 개발 전용 옵션입니다.

## 참고

- [Haiku 5.5 공식 모델 ID](https://platform.claude.com/docs/en/models/haiku-5-5/overview)
- [Anthropic structured outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)
- [Apple 로컬 네트워크 권한](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy)
- [Flutter의 플랫폼 HTTP 정책 설명](https://docs.flutter.dev/release/breaking-changes/network-policy-ios-android)
# jangjak_diary_backend

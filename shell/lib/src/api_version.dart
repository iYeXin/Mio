/// Semantic version comparison for the Mio API contract.
///
/// The shell and the app bundle are shipped independently: the shell is a
/// prebuilt template, the app is an injected `app.asar`. An app built against
/// a newer API than the shell provides must fail fast with a clear message
/// instead of throwing confusing bridge errors at runtime.
///
/// Compatibility rule: majors must match, and the runtime's minor/patch must
/// be greater than or equal to the requirement.
library;

class ApiVersion {
  const ApiVersion(this.major, this.minor, this.patch);

  final int major;
  final int minor;
  final int patch;

  static ApiVersion? tryParse(String? value) {
    if (value == null) return null;
    final parts = value.trim().split('.');
    if (parts.isEmpty || parts.length > 3) return null;
    final numbers = <int>[];
    for (final part in parts) {
      final parsed = int.tryParse(part);
      if (parsed == null || parsed < 0) return null;
      numbers.add(parsed);
    }
    while (numbers.length < 3) {
      numbers.add(0);
    }
    return ApiVersion(numbers[0], numbers[1], numbers[2]);
  }

  bool atLeast(ApiVersion other) {
    if (major != other.major) return major > other.major;
    if (minor != other.minor) return minor > other.minor;
    return patch >= other.patch;
  }

  @override
  String toString() => '$major.$minor.$patch';
}

/// Returns null when compatible, or a human readable reason when not.
String? checkApiCompatibility({
  required String runtime,
  String? required,
}) {
  if (required == null || required.trim().isEmpty) return null;

  final runtimeVersion = ApiVersion.tryParse(runtime);
  final requiredVersion = ApiVersion.tryParse(required);
  if (requiredVersion == null) {
    return 'The app requires an invalid Mio API version: "$required".';
  }
  if (runtimeVersion == null) {
    return 'The shell reports an invalid Mio API version: "$runtime".';
  }
  if (runtimeVersion.major != requiredVersion.major) {
    return 'The app requires Mio API $requiredVersion but this shell implements '
        '$runtimeVersion. Major versions are not compatible; rebuild the app '
        'with a matching Mio CLI/template, or update the shell.';
  }
  if (!runtimeVersion.atLeast(requiredVersion)) {
    return 'The app requires Mio API $requiredVersion but this shell only '
        'implements $runtimeVersion. Update the shell template.';
  }
  return null;
}

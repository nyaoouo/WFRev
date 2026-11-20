#include <android/log.h>
#include <jni.h>
#include <node.h>
#include <string>

extern "C" JNIEXPORT jint JNICALL
Java_local_starpoint_OfflineServer_runNode(JNIEnv* env, jclass, jstring script) {
    const char* path = env->GetStringUTFChars(script, nullptr);
    if (!path) return 1;
    std::string entry(path);
    env->ReleaseStringUTFChars(script, path);
    char name[] = "starpoint-node";
    char* arguments[] = {name, entry.data(), nullptr};
    __android_log_print(ANDROID_LOG_INFO, "StarPoint", "Starting embedded Node");
    return node::Start(2, arguments);
}

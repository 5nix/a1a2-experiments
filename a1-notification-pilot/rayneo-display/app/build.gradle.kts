plugins { id("com.android.application") }
android {
    namespace = "link.ironip.a5.rayneo"
    compileSdk = 37
    defaultConfig {
        applicationId = "link.ironip.a1.rayneo"
        minSdk = 31
        targetSdk = 37
        versionCode = 2
        versionName = "0.2.0"
        resValue("string", "app_name", "A1 雷鸟图片显示")
    }
    buildFeatures { viewBinding = true; resValues = true }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}
dependencies {
    implementation("androidx.appcompat:appcompat:1.6.1")
    implementation("androidx.core:core-ktx:1.10.1")
    // 本地 Mercury AAR 没有 POM；镜腿触控使用 ViewModelKt，必须显式打包其 KTX 运行依赖。
    implementation("androidx.lifecycle:lifecycle-viewmodel-ktx:2.6.1")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.6.1")
    implementation("com.google.android.material:material:1.10.0")
    implementation(files("libs/MercuryAndroidSDK-v0.2.6.aar"))
}

cmake_minimum_required(VERSION 3.25)
project(proje_b C)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)

add_executable(ring src/main.c src/ring.c)
target_include_directories(ring PRIVATE include)
target_compile_options(ring PRIVATE -Wall -Wextra)
